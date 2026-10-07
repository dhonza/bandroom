import { schema, type Db, type JobContext } from "@bandroom/server-core";
import type { ImportMapping, ImportNode, ImportProject } from "@bandroom/shared";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { SamplyClient } from "./api";
import { proposeProject, walkNodes } from "./mapping";
import { checkCancelled, emitRun, finish } from "./runState";
import {
  liveImportedFiles,
  liveLocal,
  lookupExternal,
  updateRun,
  type ImportRunRow,
} from "./store";

export async function scan(
  ctx: JobContext,
  run: ImportRunRow,
  client: SamplyClient,
): Promise<void> {
  const { db } = ctx;
  const selection = z.array(z.string()).parse(JSON.parse(run.selection));
  updateRun(db, run.id, { status: "scanning", progress: 0, error: null });
  emitRun(ctx, run.id);
  const owned = new Map((await client.listProjects()).map((p) => [p.id, p]));
  const projects: ImportProject[] = [];
  for (const [pi, samplyId] of selection.entries()) {
    checkCancelled(ctx, run.id);
    const project = owned.get(samplyId);
    if (!project) continue; // no longer owned by this account
    const boxes = await client.listBoxes(samplyId);
    const files = boxes.filter((b) => b.object === "file" && !b.trashed && !b.hidden);
    const commentCounts = new Map<string, number>();
    const sizes = new Map<string, number | null>();
    // Only files whose imported version/document still exists count (deleted ones re-import).
    const imported = liveImportedFiles(
      db,
      files.map((f) => f.id),
    );
    for (const [fi, f] of files.entries()) {
      checkCancelled(ctx, run.id);
      commentCounts.set(f.id, (await client.listComments(samplyId, f.id)).length);
      if (!imported.has(f.id)) {
        const { url } = await client.downloadUrl(samplyId, f.id);
        sizes.set(f.id, (await client.head(url)).sizeBytes);
      }
      const progress = (pi + (fi + 1) / Math.max(1, files.length)) / selection.length;
      updateRun(db, run.id, { progress });
      ctx.progress(progress, project.name);
      if (fi % 5 === 0) emitRun(ctx, run.id, { note: project.name });
    }
    const existing = liveLocal(db, "project", samplyId, "project");
    const proposed = proposeProject(project, boxes, { commentCounts, sizes, imported }, existing);
    if (existing) restorePreviousGrouping(db, proposed);
    projects.push(proposed);
  }
  const mapping: ImportMapping = { projects, includeInsights: false, scannedAt: Date.now() };
  updateRun(db, run.id, { mapping, progress: 1 });
  finish(ctx, run.id, "review", null);
}

/**
 * On a re-run, propose what the earlier run created instead of the defaults: items grouped into a
 * multitrack song stay grouped. Otherwise already imported items
 * would be proposed as separate songs again.
 */
export function restorePreviousGrouping(db: Db, project: ImportProject): void {
  const byId = new Map<string, ImportNode>();
  walkNodes(project.nodes, (n) => byId.set(n.id, n));
  const songAnchor = (songId: string | null | undefined) =>
    songId ? lookupExternal(db, "song", songId, "box") : null;
  const songTitle = (songId: string) =>
    db
      .select({ title: schema.songs.title })
      .from(schema.songs)
      .where(eq(schema.songs.id, songId))
      .get()?.title;

  walkNodes(project.nodes, (n) => {
    if (n.kind === "folder") return;
    if (n.isAudio) {
      const trackId = liveLocal(db, "box", n.id, "track");
      const track = trackId
        ? db.select().from(schema.tracks).where(eq(schema.tracks.id, trackId)).get()
        : undefined;
      if (!track) return;
      const anchor = songAnchor(track.songId);
      if (anchor === n.id) {
        // A song that holds more than this one track was grouped (SPEC §17.1, M21: no roles).
        const trackCount = db
          .select({ id: schema.tracks.id })
          .from(schema.tracks)
          .where(and(eq(schema.tracks.songId, track.songId), isNull(schema.tracks.deletedAt)))
          .all().length;
        if (trackCount > 1) {
          n.action = "songMultitrack";
          n.songTitle = songTitle(track.songId) ?? n.name;
          n.trackName = track.name;
        }
      } else if (anchor && byId.has(anchor)) {
        const target = byId.get(anchor);
        if (target?.kind === "folder") target.action = "songMultitrack";
        n.action = "trackOf";
        n.targetId = anchor;
        n.trackName = track.name;
      }
      return;
    }
    // Documents belong to the project (SPEC §28.4): nothing to restore.
  });
}
