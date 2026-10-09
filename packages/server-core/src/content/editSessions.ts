import {
  DEFAULT_EDIT_OPTIONS,
  EditBaseSchema,
  EditOpSchema,
  EditOptionsSchema,
  initialClip,
  uuidv7,
  type EditBase,
  type EditBaseTrack,
  type EditOp,
  type EditOptions,
  type EditSession,
  type SongEditing,
} from "@bandroom/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/connection";
import { editSessions, users } from "../db/schema";
import { durationSamples48k } from "../media/ingest";
import { assetProbe } from "../media/assets";
import { listSongTracks } from "./tracks";

/** Edit sessions (SPEC §24.2, §24.7). Apply and Bounce come with M18. */

export type EditSessionRow = typeof editSessions.$inferSelect;

const ACTIVE = ["open", "applying"] as const;

export function getEditSessionRow(db: Db, id: string): EditSessionRow | undefined {
  return db.select().from(editSessions).where(eq(editSessions.id, id)).get();
}

/** The session holding the song's edit lock (`open` or `applying`), if any. */
export function activeEditSession(db: Db, songId: string): EditSessionRow | undefined {
  return db
    .select()
    .from(editSessions)
    .where(and(eq(editSessions.songId, songId), inArray(editSessions.status, [...ACTIVE])))
    .get();
}

/** Whether an edit session holds the song (the central lock check, SPEC §24.7). */
export function songIsEditing(db: Db, songId: string): boolean {
  return activeEditSession(db, songId) !== undefined;
}

function nameOf(db: Db, userId: string): string {
  return db.select({ n: users.displayName }).from(users).where(eq(users.id, userId)).get()?.n ?? "";
}

/**
 * The song DTO's `editing` (SPEC §24.7): who holds the song since when; `withName: false` leaves
 * the session and the editor out (link visitors do not see band members).
 */
export function songEditingOf(db: Db, songId: string, withName = true): SongEditing | null {
  const s = activeEditSession(db, songId);
  if (!s) return null;
  const status = s.status === "applying" ? "applying" : "open";
  if (!withName)
    return { sessionId: null, status, since: s.ownerSince, by: { id: null, name: null } };
  return {
    sessionId: s.id,
    status,
    since: s.ownerSince,
    by: { id: s.ownerId, name: nameOf(db, s.ownerId) },
  };
}

const num = (x: unknown): number | null => (typeof x === "number" && x > 0 ? x : null);

function metaFrames(meta: string): number | null {
  try {
    const v: unknown = JSON.parse(meta);
    return typeof v === "object" && v !== null
      ? num((v as Record<string, unknown>).durationSamples48k)
      : null;
  } catch {
    return null;
  }
}

export type EditBaseResult =
  { ok: true; base: EditBase } | { ok: false; reason: "processing" | "empty" };

/**
 * The base of a new session (SPEC §24.7): every live track's current version when it is ready,
 * at its offset and gain, with the length the Player plays (the Opus, else the probe). A current
 * version still uploading or processing refuses (`processing`); tracks without a current version
 * or with a failed one are left out; a song without any is `empty`.
 */
export function buildEditBase(db: Db, songId: string): EditBaseResult {
  const tracks: EditBaseTrack[] = [];
  for (const item of listSongTracks(db, songId)) {
    const cur = item.current;
    if (!cur) continue;
    const status = cur.asset.status;
    if (status === "uploading" || status === "queued" || status === "processing")
      return { ok: false, reason: "processing" };
    if (status !== "ready") continue;
    const variant = (name: string) => cur.variants.find((v) => v.variant === name);
    const opus = variant("opus") ?? variant("opus_low");
    const probe = assetProbe(cur.asset);
    const lengthFrames =
      (opus ? metaFrames(opus.meta) : null) ??
      (probe ? num(durationSamples48k(probe.durationSamples, probe.sampleRate)) : null);
    if (lengthFrames === null) continue;
    const t = {
      trackId: item.track.id,
      versionId: cur.version.id,
      offsetSamples: cur.version.offsetSamples,
      gainDb: cur.version.gainDb,
      lengthFrames,
    };
    tracks.push({ ...t, clip: initialClip(t) });
  }
  if (tracks.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, base: EditBaseSchema.parse({ tracks }) };
}

/** The editing state of a session row, validated (the JSON columns are ours, but versioned). */
export interface EditSessionState {
  base: EditBase;
  ops: EditOp[];
  cursor: number;
  options: EditOptions;
}

export function sessionState(row: EditSessionRow): EditSessionState {
  return {
    base: EditBaseSchema.parse(JSON.parse(row.base)),
    ops: z.array(EditOpSchema).parse(JSON.parse(row.ops)),
    cursor: row.cursor,
    options: EditOptionsSchema.parse(JSON.parse(row.options)),
  };
}

/** The DTO (SPEC §24.11): the editing state only for its owner (`full`). */
export function toEditSession(db: Db, row: EditSessionRow, full: boolean): EditSession {
  const summary: EditSession = {
    id: row.id,
    songId: row.songId,
    status: row.status,
    owner: { id: row.ownerId, name: nameOf(db, row.ownerId) },
    since: row.ownerSince,
    updatedAt: row.updatedAt,
  };
  if (!full) return summary;
  return { ...summary, ...sessionState(row), rev: row.rev };
}

export function createEditSessionRow(
  db: Db,
  input: { songId: string; projectId: string; userId: string; base: EditBase },
  now: number = Date.now(),
): EditSessionRow {
  return db
    .insert(editSessions)
    .values({
      id: uuidv7(now),
      songId: input.songId,
      projectId: input.projectId,
      status: "open",
      ownerId: input.userId,
      ownerSince: now,
      base: JSON.stringify(input.base),
      ops: "[]",
      cursor: 0,
      options: JSON.stringify(DEFAULT_EDIT_OPTIONS),
      rev: 0,
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/**
 * Stores a save if the row still has `rev` and is open (guarded update); undefined when someone
 * else changed it meanwhile.
 */
export function saveEditSessionRow(
  db: Db,
  row: EditSessionRow,
  state: EditSessionState & { logged: boolean },
  now: number = Date.now(),
): EditSessionRow | undefined {
  return db
    .update(editSessions)
    .set({
      base: JSON.stringify(state.base),
      ops: JSON.stringify(state.ops),
      cursor: state.cursor,
      options: JSON.stringify(state.options),
      rev: row.rev + 1,
      updatedAt: now,
      ...(state.logged && { saveLoggedAt: now }),
    })
    .where(
      and(
        eq(editSessions.id, row.id),
        eq(editSessions.rev, row.rev),
        eq(editSessions.status, "open"),
      ),
    )
    .returning()
    .get();
}

/** Gives an open session to another editor; undefined when it is no longer open. */
export function takeOverEditSessionRow(
  db: Db,
  row: EditSessionRow,
  userId: string,
  now: number = Date.now(),
): EditSessionRow | undefined {
  return db
    .update(editSessions)
    .set({ ownerId: userId, ownerSince: now, rev: row.rev + 1, updatedAt: now })
    .where(and(eq(editSessions.id, row.id), eq(editSessions.status, "open")))
    .returning()
    .get();
}

/** Cancels an open session (the lock is released); undefined when it is no longer open. */
export function cancelEditSessionRow(
  db: Db,
  row: EditSessionRow,
  now: number = Date.now(),
): EditSessionRow | undefined {
  return db
    .update(editSessions)
    .set({ status: "cancelled", rev: row.rev + 1, updatedAt: now, finishedAt: now })
    .where(and(eq(editSessions.id, row.id), eq(editSessions.status, "open")))
    .returning()
    .get();
}

/** The song's sessions, newest first (tests and admin views). */
export function listEditSessionRows(db: Db, songId: string): EditSessionRow[] {
  return db
    .select()
    .from(editSessions)
    .where(eq(editSessions.songId, songId))
    .orderBy(desc(editSessions.createdAt))
    .all();
}
