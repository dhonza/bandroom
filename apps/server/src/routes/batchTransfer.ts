import {
  copySongTo,
  createProjectRow,
  followTarget,
  getSetting,
  makeMultitrackSong,
  moveSongTo,
  multitrackPreview,
  multitrackSources,
  scheduleMixdown,
  type ProjectRow,
  type SongRow,
  type UserRow,
} from "@bandroom/server-core";
import {
  batchCopySongs,
  batchCopyTracks,
  batchMakeMultitrack,
  batchMoveSongs,
  batchMultitrackPreview,
  uuidv7,
  type MakeMultitrack,
} from "@bandroom/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import type { BatchScopeAccess, BatchTarget } from "../http/batch";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";
import { notifyNewSong } from "../notify";

/** "from <song>" on markers of later sources of a multitrack song, in the user's language. */
const FROM_LABEL: Record<"en" | "cs", (title: string) => string> = {
  en: (title) => `from ${title}`,
  cs: (title) => `z písně ${title}`,
};

/**
 * Make multitrack song, copy and move of songs and tracks (SPEC §26.5, §26.6). One immediate
 * transaction per call (all or nothing, one snapshot while the worker writes); every event of a
 * call carries its `batchId`.
 */
export function registerBatchTransferRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const fromLabel = (user: UserRow) => {
    const locale = user.locale ?? getSetting(db, "defaultLocale");
    return FROM_LABEL[locale === "cs" ? "cs" : "en"];
  };

  /** The target project, created now for "new project from the selection" (in the transaction). */
  const targetProject = (
    request: FastifyRequest,
    user: UserRow,
    target: BatchTarget,
    batchId: string,
    now: number,
  ): { project: ProjectRow; created: boolean } => {
    if (target === null) throw new AppError("BAD_REQUEST", "No target project");
    if (target.kind === "project") return { project: target.project, created: false };
    const project = createProjectRow(db, { name: target.name, createdBy: user.id }, now);
    audit(db, request, {
      action: "project.created",
      projectId: project.id,
      targetType: "project",
      targetId: project.id,
      details: { name: project.name, batchId },
    });
    followTarget(db, user.id, "project", project.id, now); // creators follow what they create
    return { project, created: true };
  };

  registerContract(app, batchMultitrackPreview, ({ access }) => {
    const sources = multitrackSources(db, access.items);
    if (sources.length === 0) throw new AppError("BAD_REQUEST", "No tracks selected");
    return multitrackPreview(db, sources);
  });

  /** Make multitrack song (tracks move) and copy tracks to a new song (tracks are copied). */
  const multitrack = (
    mode: "move" | "copy",
    user: UserRow,
    body: MakeMultitrack,
    access: BatchScopeAccess,
    request: FastifyRequest,
  ) => {
    const sources = multitrackSources(db, access.items);
    if (sources.length === 0) throw new AppError("BAD_REQUEST", "No tracks selected");
    const batchId = uuidv7();
    const now = Date.now();
    const { result, project } = db.transaction(
      () => {
        const { project } = targetProject(request, user, access.target, batchId, now);
        const r = makeMultitrackSong(
          db,
          {
            mode,
            sources,
            name: body.name,
            projectId: project.id,
            userId: user.id,
            fromLabel: fromLabel(user),
            ...(body.names && { names: body.names }),
          },
          now,
        );
        audit(db, request, {
          action: "song.created",
          projectId: project.id,
          songId: r.song.id,
          targetType: "song",
          targetId: r.song.id,
          details: {
            batchId,
            title: r.song.title,
            multitrack: true,
            fromSongIds: r.sourceSongIds,
            tracks: r.tracks.length,
          },
        });
        const songsById = new Map(sources.map((s) => [s.song.id, s.song]));
        for (const t of r.tracks) {
          const from = songsById.get(t.fromSongId);
          audit(db, request, {
            action: mode === "move" ? "track.moved" : "track.copied",
            projectId: project.id,
            songId: r.song.id,
            targetType: "track",
            targetId: t.id,
            details: {
              batchId,
              name: t.name,
              fromSongId: t.fromSongId,
              fromProjectId: from?.projectId ?? null,
              ...(mode === "copy" && { fromTrackId: t.fromTrackId }),
            },
          });
          // Renamed (named after its source song, or in the dialog) or turned into a track.
          if (t.changed)
            audit(db, request, {
              action: "track.updated",
              projectId: project.id,
              songId: r.song.id,
              targetType: "track",
              targetId: t.id,
              details: {
                batchId,
                changes: [
                  ...(t.changed.name !== t.name ? ["name"] : []),
                  ...(t.changed.role !== t.role ? ["role"] : []),
                ],
                before: t.changed,
                after: { name: t.name, role: t.role },
              },
            });
        }
        for (const s of r.emptied) {
          audit(db, request, {
            action: "song.deleted",
            projectId: s.projectId,
            songId: s.id,
            targetType: "song",
            targetId: s.id,
            details: { batchId, title: s.title, emptied: true },
          });
        }
        // The automatic mixes follow: the new song and the sources that keep tracks.
        scheduleMixdown(db, r.song.id, now);
        const gone = new Set(r.emptied.map((s) => s.id));
        if (mode === "move")
          for (const id of r.sourceSongIds) if (!gone.has(id)) scheduleMixdown(db, id, now);
        return { result: r, project };
      },
      { behavior: "immediate" },
    );
    // Both projects' open lists and pages update (SPEC §26.2).
    ctx.hub.publish({
      type: "song.created",
      projectId: project.id,
      data: { songId: result.song.id },
    });
    if (mode === "move") {
      const gone = new Set(result.emptied.map((s) => s.id));
      for (const s of sources.filter(
        (x, i, all) => all.findIndex((y) => y.song.id === x.song.id) === i,
      )) {
        if (gone.has(s.song.id)) {
          ctx.hub.publish({
            type: "song.deleted",
            projectId: s.song.projectId,
            data: { songId: s.song.id },
          });
        } else {
          ctx.hub.publish({
            type: "track.moved",
            projectId: s.song.projectId,
            songId: s.song.id,
            data: { toSongId: result.song.id },
          });
        }
      }
    }
    notifyNewSong(ctx, { actor: user, project, song: result.song });
    return {
      ok: true as const,
      batchId,
      count: 1,
      projectId: project.id,
      songIds: [result.song.id],
    };
  };

  registerContract(app, batchMakeMultitrack, ({ user, body, access }, request) =>
    multitrack("move", user, body, access, request),
  );

  registerContract(app, batchCopyTracks, ({ user, body, access }, request) =>
    multitrack("copy", user, body, access, request),
  );

  registerContract(app, batchCopySongs, ({ user, access }, request) => {
    const batchId = uuidv7();
    const now = Date.now();
    const sources = access.items.map((i) => i.song);
    const { project, copies } = db.transaction(
      () => {
        const { project } = targetProject(request, user, access.target, batchId, now);
        const copies: SongRow[] = [];
        for (const from of sources) {
          const song = copySongTo(db, from, project.id, user.id, now);
          copies.push(song);
          audit(db, request, {
            action: "song.copied",
            projectId: project.id,
            songId: song.id,
            targetType: "song",
            targetId: song.id,
            details: {
              batchId,
              title: song.title,
              fromSongId: from.id,
              fromProjectId: from.projectId,
            },
          });
          scheduleMixdown(db, song.id, now);
        }
        return { project, copies };
      },
      { behavior: "immediate" },
    );
    for (const song of copies) {
      ctx.hub.publish({ type: "song.created", projectId: project.id, data: { songId: song.id } });
      notifyNewSong(ctx, { actor: user, project, song });
    }
    return {
      ok: true as const,
      batchId,
      count: copies.length,
      projectId: project.id,
      songIds: copies.map((s) => s.id),
    };
  });

  registerContract(app, batchMoveSongs, ({ user, access }, request) => {
    const target = access.target;
    const same = access.items.filter(
      (i) => target?.kind === "project" && i.song.projectId === target.project.id,
    );
    if (same.length > 0) throw new AppError("BAD_REQUEST", "Songs are already in that project");
    const batchId = uuidv7();
    const now = Date.now();
    const sources = access.items.map((i) => i.song);
    const project = db.transaction(
      () => {
        const { project } = targetProject(request, user, target, batchId, now);
        for (const song of sources) {
          const dropped = moveSongTo(db, song, project.id, now);
          audit(db, request, {
            action: "song.moved",
            projectId: project.id,
            songId: song.id,
            targetType: "song",
            targetId: song.id,
            details: {
              batchId,
              title: song.title,
              fromProjectId: song.projectId,
              toProjectId: project.id,
            },
          });
          // Song grants refine the old project's roles; they are dropped (SPEC §3.2, §26.6).
          for (const g of dropped) {
            audit(db, request, {
              action: "grant.changed",
              projectId: project.id,
              songId: song.id,
              targetType: "user",
              targetId: g.userId,
              details: { scope: "song", before: g.role, after: null, batchId, reason: "moved" },
            });
          }
        }
        return project;
      },
      { behavior: "immediate" },
    );
    for (const song of sources) {
      const data = { songId: song.id, fromProjectId: song.projectId, toProjectId: project.id };
      ctx.hub.publish({ type: "song.moved", projectId: song.projectId, data });
      ctx.hub.publish({ type: "song.moved", projectId: project.id, data });
      notifyNewSong(ctx, { actor: user, project, song: { ...song, projectId: project.id } });
    }
    return {
      ok: true as const,
      batchId,
      count: sources.length,
      projectId: project.id,
      songIds: sources.map((s) => s.id),
    };
  });
}
