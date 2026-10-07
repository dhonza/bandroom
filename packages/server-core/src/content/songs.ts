import type {
  EffectiveRole,
  Song,
  SongDownloadPolicy,
  SongLock,
  SongSummary,
} from "@bandroom/shared";
import { PaletteColorSchema, uuidv7 } from "@bandroom/shared";
import { and, eq, isNull, max } from "drizzle-orm";
import type { Db } from "../db/connection";
import { songs, users } from "../db/schema";
import { accessOf, type ProjectRow, type SongRow } from "./access";
import { touchProject } from "./projects";

export function toSongSummary(s: SongRow, role: EffectiveRole): SongSummary {
  return {
    id: s.id,
    projectId: s.projectId,
    title: s.title,
    subtitle: s.subtitle,
    key: s.key,
    sortOrder: s.sortOrder,
    updatedAt: s.updatedAt,
    access: accessOf(role),
  };
}

export function toSong(
  s: SongRow,
  project: ProjectRow,
  role: EffectiveRole,
  imageHash: string | null = null,
  locked: SongLock | null = null,
): Song {
  const color = PaletteColorSchema.safeParse(project.color);
  return {
    ...toSongSummary(s, role),
    notes: s.notes,
    locked,
    downloadPolicy: s.downloadPolicy,
    createdAt: s.createdAt,
    project: {
      id: project.id,
      name: project.name,
      color: color.success ? color.data : "violet",
      imageHash,
    },
  };
}

/** New songs go to the end of the project's list. */
export function createSongRow(
  db: Db,
  input: {
    projectId: string;
    title: string;
    subtitle?: string;
    key?: string;
    createdBy: string | null;
  },
  now: number = Date.now(),
): SongRow {
  const last = db
    .select({ m: max(songs.sortOrder) })
    .from(songs)
    .where(and(eq(songs.projectId, input.projectId), isNull(songs.deletedAt)))
    .get();
  const song = db
    .insert(songs)
    .values({
      id: uuidv7(now),
      projectId: input.projectId,
      title: input.title,
      subtitle: input.subtitle ?? "",
      key: input.key ?? "",
      sortOrder: (last?.m ?? -1) + 1,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  touchProject(db, input.projectId, now);
  return song;
}

export interface SongPatch {
  title?: string;
  subtitle?: string;
  key?: string;
  notes?: string;
  downloadPolicy?: SongDownloadPolicy;
}

export function updateSongRow(
  db: Db,
  song: SongRow,
  patch: SongPatch,
  now: number = Date.now(),
): SongRow {
  const updated = db
    .update(songs)
    .set({ ...patch, updatedAt: now })
    .where(eq(songs.id, song.id))
    .returning()
    .get();
  touchProject(db, song.projectId, now);
  return updated;
}

/**
 * The song's lock (SPEC §25.12) with the locking user's name; `withName: false` leaves the name
 * out (link visitors do not see band members).
 */
export function songLockOf(db: Db, s: SongRow, withName = true): SongLock | null {
  if (s.lockedAt === null) return null;
  if (!withName || s.lockedBy === null)
    return { at: s.lockedAt, by: { id: null, displayName: null } };
  const u = db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, s.lockedBy))
    .get();
  return { at: s.lockedAt, by: { id: s.lockedBy, displayName: u?.displayName ?? null } };
}

/** Locks (`userId`) or unlocks (null) the song. Returns the row and whether it changed. */
export function setSongLockRow(
  db: Db,
  song: SongRow,
  userId: string | null,
  locked: boolean,
  now: number = Date.now(),
): { row: SongRow; changed: boolean } {
  if ((song.lockedAt !== null) === locked) return { row: song, changed: false };
  const row = db
    .update(songs)
    .set(locked ? { lockedAt: now, lockedBy: userId } : { lockedAt: null, lockedBy: null })
    .where(eq(songs.id, song.id))
    .returning()
    .get();
  return { row, changed: true };
}

/** Moves the song to the Trash (SPEC §26.3); `by` is who deleted it. */
export function softDeleteSong(
  db: Db,
  song: SongRow,
  now: number = Date.now(),
  by: string | null = null,
): void {
  db.update(songs)
    .set({ deletedAt: now, deletedBy: by, updatedAt: now })
    .where(eq(songs.id, song.id))
    .run();
  touchProject(db, song.projectId, now);
}

/**
 * Applies a new order. Ids not in the project are ignored; songs missing from the list keep their
 * relative order after the listed ones (so a user who sees only some songs can still reorder).
 */
export function reorderSongRows(
  db: Db,
  projectId: string,
  songIds: readonly string[],
  now: number = Date.now(),
): void {
  const current = db
    .select({ id: songs.id })
    .from(songs)
    .where(and(eq(songs.projectId, projectId), isNull(songs.deletedAt)))
    .orderBy(songs.sortOrder, songs.createdAt)
    .all()
    .map((s) => s.id);
  const known = new Set(current);
  const listed = [...new Set(songIds)].filter((id) => known.has(id));
  const listedSet = new Set(listed);
  const order = [...listed, ...current.filter((id) => !listedSet.has(id))];
  db.transaction((tx) => {
    order.forEach((id, i) => {
      tx.update(songs).set({ sortOrder: i }).where(eq(songs.id, id)).run();
    });
  });
  touchProject(db, projectId, now);
}
