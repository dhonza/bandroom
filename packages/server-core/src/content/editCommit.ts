import { cutTempo, remapSteps, uuidv7, type Tempo } from "@bandroom/shared";
import { and, eq, isNull, max } from "drizzle-orm";
import type { Db } from "../db/connection";
import {
  comments,
  editRenders,
  editSessions,
  markers,
  projects,
  songs,
  tracks,
  trackVersions,
} from "../db/schema";
import { recordEvent, type EventInput } from "../events/record";
import type { JobEvent } from "../jobs/types";
import { getAsset } from "../media/assets";
import { createNotifications } from "../notifications/service";
import { type SongRow } from "./access";
import {
  failEditSession,
  listEditRenders,
  parseOutcome,
  type EditRenderRow,
  type StoredOutcome,
} from "./editRenders";
import { remapPreview, writeRemap, writeTempoRevision } from "./editRemap";
import { sessionState, type EditSessionRow } from "./editSessions";
import { followerIds } from "./follows";
import { afterTimelineChange } from "./markers";
import { touchProject } from "./projects";
import { createSongRow } from "./songs";
import { touchSongOfTrack, type TrackRow } from "./tracks";
import { copyCommentRowsInto } from "./transfer";

/**
 * The commit of an Apply/Bounce (SPEC §24.8, §24.9): once every render of the session is
 * ingested and ready, one transaction makes the hidden versions visible where they belong and
 * ends the session. Guarded on `status = 'applying'`, so it runs once.
 */

export type CommitResult =
  | { status: "waiting" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; session: EditSessionRow | undefined }
  | {
      status: "committed";
      session: EditSessionRow;
      outcome: StoredOutcome;
      /** SSE events for the API to fan out. */
      events: JobEvent[];
    };

const SR = 48_000;

function nextNumber(db: Db, trackId: string): number {
  const last = db
    .select({ m: max(trackVersions.number) })
    .from(trackVersions)
    .where(eq(trackVersions.trackId, trackId))
    .get();
  return (last?.m ?? 0) + 1;
}

function nextTrackOrder(db: Db, songId: string): number {
  const last = db
    .select({ m: max(tracks.sortOrder) })
    .from(tracks)
    .where(and(eq(tracks.songId, songId), isNull(tracks.deletedAt)))
    .get();
  return (last?.m ?? -1) + 1;
}

/** Makes a hidden version visible on `trackId` with the next number, as the current version. */
function revealVersion(
  db: Db,
  r: EditRenderRow,
  trackId: string,
  patch: { label: string; notes: string },
): string {
  const versionId = r.versionId as string;
  const number = nextNumber(db, trackId);
  db.update(trackVersions)
    .set({ trackId, number, stackOrder: number, ...patch, editSessionId: null })
    .where(eq(trackVersions.id, versionId))
    .run();
  db.update(tracks).set({ currentVersionId: versionId }).where(eq(tracks.id, trackId)).run();
  return versionId;
}

/** A copy of a track (colour, mix, practice settings) without versions, at the end of a song. */
function copyTrackRow(
  db: Db,
  from: TrackRow,
  songId: string,
  name: string,
  userId: string,
  now: number,
): TrackRow {
  return db
    .insert(tracks)
    .values({
      ...from,
      id: uuidv7(now),
      songId,
      name: name.slice(0, 120),
      sortOrder: nextTrackOrder(db, songId),
      currentVersionId: null,
      createdBy: userId,
      createdAt: now,
      deletedAt: null,
      deletedBy: null,
    })
    .returning()
    .get();
}

/**
 * Commits the session when it can (SPEC §24.8): `waiting` while a render or ingest is still
 * running; a failed render or ingest fails the session (back to `open`, nothing committed).
 */
export function commitEditSession(
  db: Db,
  sessionId: string,
  now: number = Date.now(),
): CommitResult {
  const row = db.select().from(editSessions).where(eq(editSessions.id, sessionId)).get();
  if (!row || row.status !== "applying") return { status: "skipped", reason: "not applying" };
  const outcome = parseOutcome(row.outcome);
  if (!outcome) return { status: "skipped", reason: "no outcome" };
  const renders = listEditRenders(db, sessionId);
  for (const r of renders) {
    if (r.status === "failed" || r.status === "skipped")
      return {
        status: "failed",
        session: failEditSession(db, sessionId, r.id, r.error ?? "render failed"),
      };
    const asset = r.assetId ? getAsset(db, r.assetId) : undefined;
    if (r.status === "done" && (!asset || asset.status === "failed"))
      return {
        status: "failed",
        session: failEditSession(
          db,
          sessionId,
          r.id,
          asset?.error ?? "the rendered file is gone",
          now,
        ),
      };
  }
  if (renders.some((r) => r.status !== "done" || getAsset(db, r.assetId ?? "")?.status !== "ready"))
    return { status: "waiting" };
  return db.transaction(() => {
    const keep = outcome.keepEditing;
    const claimed = db
      .update(editSessions)
      .set({
        status: keep ? "open" : "done",
        rev: row.rev + 1,
        updatedAt: now,
        error: null,
        ...(!keep && { finishedAt: now }),
      })
      .where(and(eq(editSessions.id, sessionId), eq(editSessions.status, "applying")))
      .returning()
      .all()
      .at(0);
    if (!claimed) return { status: "skipped" as const, reason: "already committed" };
    const song = db.select().from(songs).where(eq(songs.id, row.songId)).get();
    if (!song) throw new Error("song missing");
    const actor: Partial<EventInput> = {
      ts: now,
      actorType: "worker",
      actorUserId: outcome.by,
      projectId: row.projectId,
      songId: row.songId,
    };
    const events: JobEvent[] = [];
    const songEvent = (type: string, data: Record<string, unknown> = {}) =>
      events.push({
        type,
        projectId: row.projectId,
        songId: row.songId,
        data: { songId: row.songId, ...data },
      });
    const result =
      outcome.kind === "bounceSongs"
        ? commitSongs(db, row, song, outcome, renders, actor, events, now)
        : commitSameSong(db, row, outcome, renders, actor, songEvent, now);
    const finished: StoredOutcome = { ...outcome, ...result };
    const saved = db
      .update(editSessions)
      .set({ outcome: keep ? null : JSON.stringify(finished) })
      .where(eq(editSessions.id, sessionId))
      .returning()
      .get();
    db.delete(editRenders).where(eq(editRenders.sessionId, sessionId)).run();
    recordEvent(db, {
      ...actor,
      action: outcome.kind === "apply" ? "edit.applied" : "edit.bounced",
      targetType: "editSession",
      targetId: sessionId,
      details: { kind: outcome.kind, keepEditing: keep, ...result },
    });
    touchProject(db, row.projectId, now);
    songEvent("edit.changed", { sessionId, status: saved.status, rev: saved.rev });
    songEvent("song.updated", { editing: keep });
    return { status: "committed" as const, session: saved, outcome: finished, events };
  });
}

/** Apply and Bounce to versions / tracks: everything stays in the session's song. */
function commitSameSong(
  db: Db,
  row: EditSessionRow,
  outcome: StoredOutcome,
  renders: readonly EditRenderRow[],
  actor: Partial<EventInput>,
  songEvent: (type: string, data?: Record<string, unknown>) => void,
  now: number,
): Pick<StoredOutcome, "versionIds" | "trackIds" | "replacedVersionIds"> {
  const state = sessionState(row);
  const order = new Map(state.base.tracks.map((t, i) => [t.trackId, i]));
  const sorted = [...renders].sort(
    (a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0),
  );
  const versionIds: string[] = [];
  const trackIds: string[] = [];
  const replaced: string[] = [];
  const event = (e: Omit<EventInput, "ts">) => {
    recordEvent(db, { ...actor, ...e });
  };
  for (const r of sorted) {
    const track = db.select().from(tracks).where(eq(tracks.id, r.trackId)).get();
    if (!track) continue;
    const old = track.currentVersionId
      ? db.select().from(trackVersions).where(eq(trackVersions.id, track.currentVersionId)).get()
      : undefined;
    if (outcome.kind === "bounceTracks") {
      const copy = copyTrackRow(db, track, track.songId, r.title, outcome.by, now);
      const id = revealVersion(db, r, copy.id, { label: "", notes: "" });
      versionIds.push(id);
      trackIds.push(copy.id);
      continue;
    }
    const label =
      outcome.kind === "apply" ? (old?.label ?? "") : old ? `Edit of v${old.number}` : "";
    const id = revealVersion(db, r, track.id, {
      label,
      notes: outcome.kind === "apply" ? (old?.notes ?? "") : "",
    });
    versionIds.push(id);
    event({
      action: "version.set_current",
      targetType: "trackVersion",
      targetId: id,
      details: { trackId: track.id, previous: old?.id ?? null, reason: "edit" },
    });
    if (outcome.kind === "apply" && old) {
      trashVersion(db, old.id, outcome.by, now);
      replaced.push(old.id);
      event({
        action: "version.deleted",
        targetType: "trackVersion",
        targetId: old.id,
        details: { trackId: track.id, number: old.number, reason: "edit" },
      });
    }
  }
  // Apply: tracks left without audio lose their current version (to the Trash).
  for (const trackId of outcome.kind === "apply" ? outcome.emptied : []) {
    const track = db.select().from(tracks).where(eq(tracks.id, trackId)).get();
    if (!track?.currentVersionId) continue;
    const old = track.currentVersionId;
    trashVersion(db, old, outcome.by, now);
    db.update(tracks).set({ currentVersionId: null }).where(eq(tracks.id, trackId)).run();
    replaced.push(old);
    event({
      action: "version.deleted",
      targetType: "trackVersion",
      targetId: old,
      details: { trackId, reason: "edit" },
    });
  }
  if (outcome.kind !== "bounceTracks") {
    const steps = remapSteps(state.base, state.ops, state.cursor);
    if (steps.length > 0) {
      const preview = remapPreview(db, row.songId, steps, row.id);
      const written = writeRemap(db, row.songId, preview, outcome.by, now);
      event({
        action: "timeline.remapped",
        targetType: "song",
        targetId: row.songId,
        details: {
          ...preview.summary,
          tempoRevisionId: written.tempoRevisionId,
          sessionId: row.id,
        },
      });
      songEvent("marker.changed");
      songEvent("comment.changed");
      if (written.tempoRevisionId) songEvent("tempo.changed");
    }
  }
  afterTimelineChange(db, row.songId, now);
  touchSongOfTrack(db, row.songId, now);
  songEvent("version.set_current");
  if (replaced.length > 0) {
    songEvent("version.deleted", { versionIds: replaced });
    songEvent("trash.changed");
  }
  return {
    versionIds,
    ...(trackIds.length > 0 && { trackIds }),
    ...(replaced.length > 0 && { replacedVersionIds: replaced }),
  };
}

function trashVersion(db: Db, versionId: string, by: string, now: number): void {
  db.update(trackVersions)
    .set({ deletedAt: now, deletedBy: by })
    .where(eq(trackVersions.id, versionId))
    .run();
}

/** Split into songs: one new song per range, after the source in timeline order. */
function commitSongs(
  db: Db,
  row: EditSessionRow,
  source: SongRow,
  outcome: StoredOutcome,
  renders: readonly EditRenderRow[],
  actor: Partial<EventInput>,
  events: JobEvent[],
  now: number,
): Pick<StoredOutcome, "songIds" | "trackIds" | "versionIds"> {
  const state = sessionState(row);
  const order = new Map(state.base.tracks.map((t, i) => [t.trackId, i]));
  const steps = remapSteps(state.base, state.ops, state.cursor);
  const preview = remapPreview(db, row.songId, steps, row.id);
  const mappedComments = new Map(preview.comments.items.map((c) => [c.id, c]));
  const allComments = db.select().from(comments).where(eq(comments.songId, row.songId)).all();
  const sourceTracks = new Map(
    db
      .select()
      .from(tracks)
      .where(eq(tracks.songId, row.songId))
      .all()
      .map((t) => [t.id, t]),
  );
  const ranges = outcome.ranges ?? [];
  const songIds: string[] = [];
  const trackIds: string[] = [];
  const versionIds: string[] = [];
  let after: Pick<SongRow, "projectId" | "sortOrder"> = source;
  ranges.forEach((range, i) => {
    const mine = renders
      .filter((r) => r.rangeIndex === i)
      .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0));
    if (mine.length === 0) return;
    const song = createSongRow(
      db,
      {
        projectId: source.projectId,
        title: range.title,
        key: source.key,
        createdBy: outcome.by,
        after,
      },
      now,
    );
    after = song;
    songIds.push(song.id);
    const trackMap = new Map<string, string>();
    for (const r of mine) {
      const from = sourceTracks.get(r.trackId);
      if (!from) continue;
      const copy = copyTrackRow(db, from, song.id, r.title, outcome.by, now);
      versionIds.push(revealVersion(db, r, copy.id, { label: "", notes: "" }));
      trackIds.push(copy.id);
      trackMap.set(from.id, copy.id);
    }
    const S = range.startFrame / SR;
    const E = range.endFrame / SR;
    // Markers and sections of the range (shifted, clipped, time-anchored; its own section not).
    for (const m of preview.markers.items) {
      if (m.id === range.id && m.type === "section") continue;
      let start = m.startSec;
      let end = m.endSec;
      if (end === null) {
        if (start < S || start >= E) continue;
      } else {
        if (end <= S || start >= E) continue;
        start = Math.max(start, S);
        end = Math.min(end, E);
        if (end <= start) continue;
      }
      const id = uuidv7(now);
      db.insert(markers)
        .values({
          ...m,
          id,
          songId: song.id,
          startSec: start - S,
          endSec: end === null ? null : end - S,
          anchor: "time",
          startBeat: null,
          endBeat: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })
        .run();
    }
    // Comment threads whose time lies in the range.
    const roots = allComments.filter((c) => {
      const m = mappedComments.get(c.id);
      if (c.parentId !== null || c.deletedAt !== null || !m || m.startSec === null) return false;
      return m.endSec === null ? m.startSec >= S && m.startSec < E : m.endSec > S && m.startSec < E;
    });
    const rootIds = new Set(roots.map((c) => c.id));
    const rows = [
      ...roots.map((c) => {
        const m = mappedComments.get(c.id);
        const start = Math.max(m?.startSec ?? S, S);
        const end = m?.endSec == null ? null : Math.min(m.endSec, E);
        return { ...c, startSec: start - S, endSec: end === null ? null : end - S };
      }),
      ...allComments.filter((c) => c.parentId !== null && rootIds.has(c.parentId)),
    ];
    copyCommentRowsInto(db, rows, song.id, trackMap, now);
    if (outcome.carryTempo && preview.tempoAfter) {
      const tempo: Tempo = S > 0 ? cutTempo(preview.tempoAfter, 0, S) : preview.tempoAfter;
      writeTempoRevision(
        db,
        song.id,
        tempo,
        { source: "edit", midiAssetId: null, userId: outcome.by },
        now,
      );
    }
    afterTimelineChange(db, song.id, now);
    recordEvent(db, {
      ...actor,
      songId: song.id,
      action: "song.created",
      targetType: "song",
      targetId: song.id,
      details: {
        title: song.title,
        edit: { sessionId: row.id, sourceSongId: row.songId, rangeId: range.id },
      },
    });
    events.push({
      type: "song.created",
      projectId: song.projectId,
      songId: song.id,
      data: { songId: song.id, projectId: song.projectId },
    });
  });
  // One project notification per bounce (SPEC §24.9).
  const project = db.select().from(projects).where(eq(projects.id, row.projectId)).get();
  const actorName = userName(db, outcome.by);
  if (project && songIds.length > 0) {
    const created = createNotifications(
      db,
      {
        type: "edit_bounced",
        userIds: followerIds(db, "project", project.id),
        actorId: outcome.by,
        projectId: project.id,
        payload: {
          actorName: actorName || null,
          projectId: project.id,
          projectName: project.name,
          songId: source.id,
          songTitle: source.title,
          count: songIds.length,
        },
      },
      now,
    );
    for (const c of created)
      events.push({
        type: "notification",
        userId: c.userId,
        data: { id: c.id, kind: "edit_bounced" },
      });
  }
  return { songIds, trackIds, versionIds };
}

function userName(db: Db, userId: string): string {
  const r = db.$client.prepare("SELECT display_name AS n FROM users WHERE id = ?").get(userId) as
    { n: string } | undefined;
  return r?.n ?? "";
}
