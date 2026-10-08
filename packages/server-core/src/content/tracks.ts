import {
  autoTrackColor,
  uuidv7,
  type FormantMode,
  type Instrument,
  type VoiceRange,
} from "@bandroom/shared";
import { and, asc, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import { MEDIA_JOB_TYPES } from "./processing";
import {
  assets,
  assetVariants,
  blobs,
  jobs,
  songs,
  tracks,
  trackVersions,
  users,
} from "../db/schema";
import { assetProbe, type AssetRow } from "../media/assets";
import type { Probe } from "../media/probe";
import { touchProject } from "./projects";

export type TrackRow = typeof tracks.$inferSelect;
export type TrackVersionRow = typeof trackVersions.$inferSelect;

export function getTrackRow(db: Db, id: string): TrackRow | undefined {
  return db
    .select()
    .from(tracks)
    .where(and(eq(tracks.id, id), isNull(tracks.deletedAt)))
    .get();
}

export function getTrackVersionRow(db: Db, id: string): TrackVersionRow | undefined {
  return db
    .select()
    .from(trackVersions)
    .where(and(eq(trackVersions.id, id), isNull(trackVersions.deletedAt)))
    .get();
}

/** Song id owning a track / track version (for scope resolution). */
export function songIdOfTrack(db: Db, trackId: string): string | undefined {
  return getTrackRow(db, trackId)?.songId;
}

export function songIdOfTrackVersion(db: Db, versionId: string): string | undefined {
  const v = getTrackVersionRow(db, versionId);
  return v && songIdOfTrack(db, v.trackId);
}

/**
 * Creates a track with its first version pointing at an uploaded asset (uploads, recordings and
 * imports), with an automatic colour.
 */
export function createTrackWithVersion(
  db: Db,
  input: {
    songId: string;
    name: string;
    assetId: string;
    uploadedBy: string;
    source?: TrackVersionRow["source"];
    /** Stored instrument (SPEC §30.3), e.g. `mix` for a bounce; default: guessed at read time. */
    instrument?: Instrument | null;
  },
  now: number = Date.now(),
): { track: TrackRow; version: TrackVersionRow } {
  return db.transaction(() => {
    const siblings = db
      .select({ color: tracks.color })
      .from(tracks)
      .where(and(eq(tracks.songId, input.songId), isNull(tracks.deletedAt)))
      .all();
    const last = db
      .select({ m: max(tracks.sortOrder) })
      .from(tracks)
      .where(and(eq(tracks.songId, input.songId), isNull(tracks.deletedAt)))
      .get();
    const name = input.name.slice(0, 120);
    const track = db
      .insert(tracks)
      .values({
        id: uuidv7(now),
        songId: input.songId,
        name,
        // SPEC §25.10: by instrument, else a colour the song does not use yet, else round-robin.
        color: autoTrackColor(
          { name, instrument: input.instrument ?? null },
          { usedColors: siblings.map((t) => t.color), trackCount: siblings.length },
        ),
        sortOrder: (last?.m ?? -1) + 1,
        instrument: input.instrument ?? null,
        createdBy: input.uploadedBy,
        createdAt: now,
      })
      .returning()
      .get();
    const version = insertVersion(
      db,
      track.id,
      input.assetId,
      input.uploadedBy,
      input.source ?? "upload",
      now,
    );
    const updated = db
      .update(tracks)
      .set({ currentVersionId: version.id })
      .where(eq(tracks.id, track.id))
      .returning()
      .get();
    touchSongOfTrack(db, track.songId, now);
    return { track: updated, version };
  });
}

/** Adds a new version to a track and makes it current (SPEC §11.3: new exports become current). */
export function addTrackVersion(
  db: Db,
  input: {
    trackId: string;
    assetId: string;
    uploadedBy: string;
    source?: TrackVersionRow["source"];
  },
  now: number = Date.now(),
): TrackVersionRow {
  return db.transaction(() => {
    const version = insertVersion(
      db,
      input.trackId,
      input.assetId,
      input.uploadedBy,
      input.source ?? "upload",
      now,
    );
    const track = db
      .update(tracks)
      .set({ currentVersionId: version.id })
      .where(eq(tracks.id, input.trackId))
      .returning()
      .get();
    touchSongOfTrack(db, track.songId, now);
    return version;
  });
}

function insertVersion(
  db: Db,
  trackId: string,
  assetId: string,
  uploadedBy: string,
  source: TrackVersionRow["source"],
  now: number,
): TrackVersionRow {
  const last = db
    .select({ m: max(trackVersions.number) })
    .from(trackVersions)
    .where(eq(trackVersions.trackId, trackId))
    .get();
  const number = (last?.m ?? 0) + 1;
  return db
    .insert(trackVersions)
    .values({
      id: uuidv7(now),
      trackId,
      number,
      stackOrder: number,
      assetId,
      source,
      uploadedBy,
      createdAt: now,
    })
    .returning()
    .get();
}

export function touchSongOfTrack(db: Db, songId: string, now: number): void {
  const song = db
    .update(songs)
    .set({ updatedAt: now })
    .where(eq(songs.id, songId))
    .returning({ projectId: songs.projectId })
    .get();
  touchProject(db, song.projectId, now);
}

/** Moves the track to the Trash (SPEC §26.3); `by` is who deleted it. */
export function softDeleteTrack(
  db: Db,
  trackId: string,
  now: number = Date.now(),
  by: string | null = null,
): void {
  const t = db
    .update(tracks)
    .set({ deletedAt: now, deletedBy: by })
    .where(eq(tracks.id, trackId))
    .returning()
    .get();
  touchSongOfTrack(db, t.songId, now);
}

export interface TrackListVersion {
  version: TrackVersionRow;
  asset: AssetRow;
  probe: Probe | null;
  /** `sizeBytes`: the stored file's size (SPEC §28.6). */
  variants: { variant: string; blobHash: string; meta: string; sizeBytes?: number }[];
  uploaderName: string | null;
  /** Who removed the full-quality files (SPEC §26.4), when they did. */
  archiverName: string | null;
  progress: number | null;
}

export interface TrackListItem {
  track: TrackRow;
  current: TrackListVersion | null;
  versionCount: number;
}

/** Tracks of a song with their current version, for the song page. */
export function listSongTracks(db: Db, songId: string): TrackListItem[] {
  const list = db
    .select()
    .from(tracks)
    .where(and(eq(tracks.songId, songId), isNull(tracks.deletedAt)))
    .orderBy(asc(tracks.sortOrder), asc(tracks.createdAt))
    .all();
  return list.map((track) => {
    const versionCount = db
      .select({ id: trackVersions.id })
      .from(trackVersions)
      .where(and(eq(trackVersions.trackId, track.id), isNull(trackVersions.deletedAt)))
      .all().length;
    const version = track.currentVersionId
      ? getTrackVersionRow(db, track.currentVersionId)
      : undefined;
    return { track, versionCount, current: version ? versionDetails(db, version) : null };
  });
}

export function versionDetails(db: Db, version: TrackVersionRow): TrackListVersion | null {
  const asset = db.select().from(assets).where(eq(assets.id, version.assetId)).get();
  if (!asset) return null;
  const variants = db
    .select({
      variant: assetVariants.variant,
      blobHash: assetVariants.blobHash,
      meta: assetVariants.meta,
      sizeBytes: sql<number>`COALESCE(${blobs.sizeBytes}, 0)`,
    })
    .from(assetVariants)
    .leftJoin(blobs, eq(blobs.hash, assetVariants.blobHash))
    .where(eq(assetVariants.assetId, asset.id))
    .all();
  const uploaderName = version.uploadedBy
    ? (db.select({ n: users.displayName }).from(users).where(eq(users.id, version.uploadedBy)).get()
        ?.n ?? null)
    : null;
  const archiverName = version.archivedBy
    ? (db.select({ n: users.displayName }).from(users).where(eq(users.id, version.archivedBy)).get()
        ?.n ?? null)
    : null;
  let progress: number | null = null;
  if (asset.status === "queued" || asset.status === "processing") {
    const job = db
      .select({ progress: jobs.progress, payload: jobs.payload })
      .from(jobs)
      .where(and(inArray(jobs.type, MEDIA_JOB_TYPES), inArray(jobs.status, ["queued", "running"])))
      .orderBy(desc(jobs.createdAt))
      .all()
      .find((j) => j.payload.includes(asset.id));
    progress = job?.progress ?? 0;
  }
  return {
    version,
    asset,
    probe: assetProbe(asset),
    variants,
    uploaderName,
    archiverName,
    progress,
  };
}

// --- Version stack & track management (SPEC §11.3, M4) ------------------------------------------

/** All non-deleted versions of a track, newest stack position first. */
export function listTrackVersions(db: Db, trackId: string): TrackListVersion[] {
  return db
    .select()
    .from(trackVersions)
    .where(and(eq(trackVersions.trackId, trackId), isNull(trackVersions.deletedAt)))
    .orderBy(desc(trackVersions.stackOrder), desc(trackVersions.number))
    .all()
    .flatMap((v) => {
      const d = versionDetails(db, v);
      return d ? [d] : [];
    });
}

export function setCurrentVersion(
  db: Db,
  trackId: string,
  versionId: string,
  now: number = Date.now(),
): void {
  const t = db
    .update(tracks)
    .set({ currentVersionId: versionId })
    .where(eq(tracks.id, trackId))
    .returning()
    .get();
  touchSongOfTrack(db, t.songId, now);
}

export function updateTrackVersion(
  db: Db,
  id: string,
  patch: { label?: string; notes?: string; offsetSamples?: number; gainDb?: number },
): TrackVersionRow {
  return db.update(trackVersions).set(patch).where(eq(trackVersions.id, id)).returning().get();
}

/** New stack order, top first. Versions not listed keep their relative order below. */
export function reorderTrackVersions(db: Db, trackId: string, versionIds: readonly string[]): void {
  const current = listTrackVersions(db, trackId).map((v) => v.version.id);
  const known = new Set(current);
  const listed = [...new Set(versionIds)].filter((id) => known.has(id));
  const order = [...listed, ...current.filter((id) => !listed.includes(id))];
  db.transaction(() => {
    order.forEach((id, i) => {
      db.update(trackVersions)
        .set({ stackOrder: order.length - i })
        .where(eq(trackVersions.id, id))
        .run();
    });
  });
}

/**
 * Soft-deletes a version. If it was current, the newest remaining version (highest number)
 * becomes current; a track without versions keeps existing with no current version.
 */
export function softDeleteTrackVersion(
  db: Db,
  versionId: string,
  now: number = Date.now(),
  by: string | null = null,
): TrackRow {
  return db.transaction(() => {
    const v = db
      .update(trackVersions)
      .set({ deletedAt: now, deletedBy: by })
      .where(eq(trackVersions.id, versionId))
      .returning()
      .get();
    let track = db.select().from(tracks).where(eq(tracks.id, v.trackId)).get();
    if (track && track.currentVersionId === versionId) {
      const next = db
        .select({ id: trackVersions.id })
        .from(trackVersions)
        .where(and(eq(trackVersions.trackId, v.trackId), isNull(trackVersions.deletedAt)))
        .orderBy(desc(trackVersions.number))
        .get();
      track = db
        .update(tracks)
        .set({ currentVersionId: next?.id ?? null })
        .where(eq(tracks.id, v.trackId))
        .returning()
        .get();
    }
    if (!track) throw new Error("track missing");
    touchSongOfTrack(db, track.songId, now);
    return track;
  });
}

export interface TrackPatch {
  name?: string;
  color?: string;
  defaultGainDb?: number;
  defaultPan?: number;
  defaultMuted?: boolean;
  instrumentTag?: string;
  instrument?: Instrument | null;
  transpose?: boolean | null;
  voiceRange?: VoiceRange | null;
  formantMode?: FormantMode | null;
  formantShift?: number;
}

export function updateTrack(
  db: Db,
  id: string,
  patch: TrackPatch,
  now: number = Date.now(),
): TrackRow {
  const t = db.update(tracks).set(patch).where(eq(tracks.id, id)).returning().get();
  touchSongOfTrack(db, t.songId, now);
  return t;
}

/** New order of a song's (visible) tracks. */
export function reorderTracks(db: Db, songId: string, trackIds: readonly string[]): void {
  const current = db
    .select({ id: tracks.id })
    .from(tracks)
    .where(and(eq(tracks.songId, songId), isNull(tracks.deletedAt)))
    .orderBy(asc(tracks.sortOrder), asc(tracks.createdAt))
    .all()
    .map((t) => t.id);
  const known = new Set(current);
  const listed = [...new Set(trackIds)].filter((id) => known.has(id));
  const order = [...listed, ...current.filter((id) => !listed.includes(id))];
  db.transaction(() => {
    order.forEach((id, i) => {
      db.update(tracks).set({ sortOrder: i }).where(eq(tracks.id, id)).run();
    });
  });
}

/**
 * Songs (of the given ids) that can play (SPEC §6.10, §18.3): at least one live track whose current
 * version's asset is ready.
 */
export function readySongIds(db: Db, songIds: readonly string[]): Set<string> {
  if (songIds.length === 0) return new Set();
  return new Set(
    db
      .select({ songId: tracks.songId })
      .from(tracks)
      .innerJoin(trackVersions, eq(trackVersions.id, tracks.currentVersionId))
      .innerJoin(assets, eq(assets.id, trackVersions.assetId))
      .where(
        and(
          inArray(tracks.songId, [...songIds]),
          isNull(tracks.deletedAt),
          isNull(trackVersions.deletedAt),
          eq(assets.status, "ready"),
        ),
      )
      .all()
      .map((r) => r.songId),
  );
}
