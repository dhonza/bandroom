import {
  assignLanes,
  PaletteColorSchema,
  secToBeat,
  uuidv7,
  type CreateMarker,
  type Marker,
  type MarkerAnchor,
  type TempoGrid,
  type UpdateMarker,
  type WhatsNew,
} from "@bandroom/shared";
import { and, asc, count, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import { comments, markers, songs, songVisits, tracks, trackVersions, users } from "../db/schema";

export type MarkerRow = typeof markers.$inferSelect;

/** Includes soft-deleted rows (restore needs them). */
export function getMarkerRow(db: Db, id: string): MarkerRow | undefined {
  return db.select().from(markers).where(eq(markers.id, id)).get();
}

/** Song id owning a marker (for scope resolution); deleted markers still resolve for undo. */
export function songIdOfMarker(db: Db, id: string): string | undefined {
  return getMarkerRow(db, id)?.songId;
}

function toMarker(r: MarkerRow, createdByName: string | null): Marker {
  const color = PaletteColorSchema.safeParse(r.color);
  return {
    id: r.id,
    songId: r.songId,
    type: r.type,
    name: r.name,
    color: color.success ? color.data : "blue",
    note: r.note,
    startSec: r.startSec,
    endSec: r.type === "section" ? r.endSec : null,
    anchor: r.anchor,
    startBeat: r.startBeat,
    endBeat: r.endBeat,
    lane: r.lane,
    createdBy: r.createdBy,
    createdByName,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function listMarkers(db: Db, songId: string): Marker[] {
  return db
    .select({ m: markers, name: users.displayName })
    .from(markers)
    .leftJoin(users, eq(users.id, markers.createdBy))
    .where(and(eq(markers.songId, songId), isNull(markers.deletedAt)))
    .orderBy(asc(markers.startSec), asc(markers.createdAt))
    .all()
    .map((r) => toMarker(r.m, r.name));
}

export function markerById(db: Db, id: string): Marker | undefined {
  const r = db
    .select({ m: markers, name: users.displayName })
    .from(markers)
    .leftJoin(users, eq(users.id, markers.createdBy))
    .where(eq(markers.id, id))
    .get();
  return r && toMarker(r.m, r.name);
}

export function songTimelineRev(db: Db, songId: string): number {
  return (
    db.select({ rev: songs.timelineRev }).from(songs).where(eq(songs.id, songId)).get()?.rev ?? 0
  );
}

/** Beats are stored rounded to 1e-9 quarter notes (well below a sample at any tempo). */
const roundBeat = (b: number) => Math.round(b * 1e9) / 1e9;

/**
 * Anchor columns for an item at `startSec`/`endSec` (SPEC §7.4): `musical` needs the song's
 * tempo grid; without one the item stays time-anchored.
 */
export function anchorFields(
  grid: TempoGrid | null,
  anchor: MarkerAnchor,
  startSec: number,
  endSec: number | null,
): { anchor: MarkerAnchor; startBeat: number | null; endBeat: number | null } {
  if (anchor === "time" || !grid) return { anchor: "time", startBeat: null, endBeat: null };
  return {
    anchor: "musical",
    startBeat: roundBeat(secToBeat(grid, startSec)),
    endBeat: endSec === null ? null : roundBeat(secToBeat(grid, endSec)),
  };
}

/** Re-stacks overlapping sections and bumps the song's timeline revision (cache invalidation). */
export function afterTimelineChange(db: Db, songId: string, now: number): void {
  const sections = db
    .select({
      id: markers.id,
      startSec: markers.startSec,
      endSec: markers.endSec,
      createdAt: markers.createdAt,
      lane: markers.lane,
    })
    .from(markers)
    .where(and(eq(markers.songId, songId), eq(markers.type, "section"), isNull(markers.deletedAt)))
    .all()
    .map((s) => ({ ...s, endSec: s.endSec ?? s.startSec }));
  const lanes = assignLanes(sections);
  for (const s of sections) {
    const lane = lanes.get(s.id) ?? 0;
    if (lane !== s.lane) db.update(markers).set({ lane }).where(eq(markers.id, s.id)).run();
  }
  db.update(songs)
    .set({ timelineRev: sql`${songs.timelineRev} + 1`, updatedAt: now })
    .where(eq(songs.id, songId))
    .run();
}

export function createMarkerRow(
  db: Db,
  songId: string,
  input: CreateMarker,
  createdBy: string,
  now: number = Date.now(),
  grid: TempoGrid | null = null,
): Marker {
  const id = uuidv7();
  const endSec = input.type === "section" ? (input.endSec ?? null) : null;
  db.transaction(() => {
    db.insert(markers)
      .values({
        id,
        songId,
        type: input.type,
        name: input.name,
        color: input.color,
        note: input.note ?? "",
        startSec: input.startSec,
        endSec,
        ...anchorFields(grid, input.anchor ?? "time", input.startSec, endSec),
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    afterTimelineChange(db, songId, now);
  });
  const m = markerById(db, id);
  if (!m) throw new Error("marker vanished");
  return m;
}

/** Applies a patch; null when the result would be invalid (a section must end after it starts). */
export function updateMarkerRow(
  db: Db,
  row: MarkerRow,
  patch: UpdateMarker,
  now: number = Date.now(),
  grid: TempoGrid | null = null,
): Marker | null {
  const startSec = patch.startSec ?? row.startSec;
  const endSec = row.type === "section" ? (patch.endSec ?? row.endSec) : null;
  if (row.type === "section" && (endSec === null || endSec <= startSec)) return null;
  db.transaction(() => {
    db.update(markers)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.color !== undefined && { color: patch.color }),
        ...(patch.note !== undefined && { note: patch.note }),
        startSec,
        endSec,
        ...anchorFields(grid, patch.anchor ?? row.anchor, startSec, endSec),
        updatedAt: now,
      })
      .where(eq(markers.id, row.id))
      .run();
    afterTimelineChange(db, row.songId, now);
  });
  return markerById(db, row.id) ?? null;
}

export function setMarkerDeleted(
  db: Db,
  row: MarkerRow,
  deleted: boolean,
  now: number = Date.now(),
): void {
  db.transaction(() => {
    db.update(markers)
      .set({ deletedAt: deleted ? now : null, updatedAt: now })
      .where(eq(markers.id, row.id))
      .run();
    afterTimelineChange(db, row.songId, now);
  });
}

// --- Visits and "What's new" (SPEC §4.4, §11.3) ------------------------------------------------

export function lastSongVisit(db: Db, userId: string, songId: string): number | null {
  return (
    db
      .select({ at: songVisits.lastVisitedAt })
      .from(songVisits)
      .where(and(eq(songVisits.userId, userId), eq(songVisits.songId, songId)))
      .get()?.at ?? null
  );
}

export function recordSongVisitRow(
  db: Db,
  userId: string,
  songId: string,
  now: number = Date.now(),
): void {
  db.insert(songVisits)
    .values({ userId, songId, lastVisitedAt: now })
    .onConflictDoUpdate({
      target: [songVisits.userId, songVisits.songId],
      set: { lastVisitedAt: now },
    })
    .run();
}

const WHATS_NEW_LIMIT = 20;

/** Versions, markers and comments by others since the user's previous visit. */
export function songWhatsNew(db: Db, userId: string, songId: string): WhatsNew {
  const since = lastSongVisit(db, userId, songId);
  if (since === null)
    return { since, versions: [], markers: [], commentCount: 0, firstComment: null };
  const byOthers = (col: typeof trackVersions.uploadedBy | typeof markers.createdBy) =>
    or(isNull(col), ne(col, userId));
  const versions = db
    .select({
      trackId: tracks.id,
      trackName: tracks.name,
      versionId: trackVersions.id,
      number: trackVersions.number,
      byName: users.displayName,
      createdAt: trackVersions.createdAt,
    })
    .from(trackVersions)
    .innerJoin(tracks, eq(tracks.id, trackVersions.trackId))
    .leftJoin(users, eq(users.id, trackVersions.uploadedBy))
    .where(
      and(
        eq(tracks.songId, songId),
        isNull(tracks.deletedAt),
        isNull(trackVersions.deletedAt),
        gt(trackVersions.createdAt, since),
        byOthers(trackVersions.uploadedBy),
      ),
    )
    .orderBy(asc(trackVersions.createdAt))
    .limit(WHATS_NEW_LIMIT)
    .all();
  const newMarkers = db
    .select({
      id: markers.id,
      type: markers.type,
      name: markers.name,
      startSec: markers.startSec,
      byName: users.displayName,
    })
    .from(markers)
    .leftJoin(users, eq(users.id, markers.createdBy))
    .where(
      and(
        eq(markers.songId, songId),
        isNull(markers.deletedAt),
        gt(markers.createdAt, since),
        byOthers(markers.createdBy),
      ),
    )
    .orderBy(asc(markers.startSec))
    .limit(WHATS_NEW_LIMIT)
    .all();
  const newComments = and(
    eq(comments.songId, songId),
    isNull(comments.deletedAt),
    gt(comments.createdAt, since),
    or(isNull(comments.authorUserId), ne(comments.authorUserId, userId)),
  );
  const commentCount = db.select({ n: count() }).from(comments).where(newComments).get()?.n ?? 0;
  const first = db
    .select({ id: comments.id, parentId: comments.parentId, startSec: comments.startSec })
    .from(comments)
    .where(newComments)
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(1)
    .get();
  const firstComment = first ? { id: first.parentId ?? first.id, startSec: first.startSec } : null;
  return { since, versions, markers: newMarkers, commentCount, firstComment };
}
