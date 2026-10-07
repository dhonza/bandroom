import fs from "node:fs/promises";
import path from "node:path";
import {
  beatToSec,
  compileTempo,
  TempoMapSchema,
  uuidv7,
  type SongTempo,
  type TempoGrid,
  type TempoMap,
  type TempoRevision,
  type TempoSource,
} from "@bandroom/shared";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/connection";
import { assets, markers, tempoMapRevisions, tempoMaps, users } from "../db/schema";
import { createOriginalAsset, setAssetStatus } from "../media/assets";
import type { StorageBackend } from "../storage/backend";
import { storeFile } from "../storage/blobs";
import { sha256File } from "../storage/hash";
import { afterTimelineChange } from "./markers";

/** Tempo maps and their revisions (SPEC §4.2, §7.1–§7.3). */

export type TempoRow = typeof tempoMaps.$inferSelect;
type RevisionRow = typeof tempoMapRevisions.$inferSelect;

function parseMap(json: string): TempoMap | null {
  try {
    const r = TempoMapSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function getTempoRow(db: Db, songId: string): TempoRow | undefined {
  return db.select().from(tempoMaps).where(eq(tempoMaps.songId, songId)).get();
}

/** The compiled tempo grid of a song, or null without a (valid) tempo map. */
export function songTempoGrid(db: Db, songId: string): TempoGrid | null {
  const row = getTempoRow(db, songId);
  const map = row && parseMap(row.data);
  return row && map ? compileTempo({ map, bar1OffsetSec: row.bar1OffsetSec }) : null;
}

export function songTempo(db: Db, songId: string): SongTempo | null {
  const r = db
    .select({ t: tempoMaps, by: users.displayName, file: assets.originalFilename })
    .from(tempoMaps)
    .leftJoin(users, eq(users.id, tempoMaps.updatedBy))
    .leftJoin(assets, eq(assets.id, tempoMaps.midiAssetId))
    .where(eq(tempoMaps.songId, songId))
    .get();
  const map = r && parseMap(r.t.data);
  if (!r || !map) return null;
  return {
    map,
    bar1OffsetSec: r.t.bar1OffsetSec,
    source: r.t.source,
    midiFileName: r.file,
    revisionId: r.t.revisionId,
    updatedByName: r.by,
    updatedAt: r.t.updatedAt,
  };
}

/**
 * Moves musical items to where their beats fall with the new tempo (SPEC §7.4), or turns them
 * into time-anchored items when the tempo map is removed. Deleted items move too (undo).
 */
function moveMusicalMarkers(db: Db, songId: string, grid: TempoGrid | null, now: number): number {
  const rows = db
    .select()
    .from(markers)
    .where(
      and(eq(markers.songId, songId), eq(markers.anchor, "musical"), isNotNull(markers.startBeat)),
    )
    .all();
  const clamp = (s: number) => Math.max(0, Math.min(86_400, s));
  for (const m of rows) {
    if (!grid) {
      db.update(markers)
        .set({ anchor: "time", startBeat: null, endBeat: null, updatedAt: now })
        .where(eq(markers.id, m.id))
        .run();
      continue;
    }
    const startSec = clamp(beatToSec(grid, m.startBeat ?? 0));
    const endSec = m.endBeat === null ? m.endSec : clamp(beatToSec(grid, m.endBeat));
    db.update(markers).set({ startSec, endSec, updatedAt: now }).where(eq(markers.id, m.id)).run();
  }
  return rows.length;
}

export interface TempoInput {
  map: TempoMap;
  bar1OffsetSec: number;
  source: TempoSource;
  midiAssetId: string | null;
}

/**
 * Saves the song's tempo map as a new revision, moves musical items and bumps the timeline
 * revision. Returns the number of musical items that moved.
 */
export function saveSongTempo(
  db: Db,
  songId: string,
  input: TempoInput,
  userId: string,
  now: number = Date.now(),
): { moved: number; revisionId: string } {
  return db.transaction(() => {
    const revisionId = uuidv7(now);
    const data = JSON.stringify(input.map);
    db.insert(tempoMapRevisions)
      .values({
        id: revisionId,
        songId,
        source: input.source,
        data,
        midiAssetId: input.midiAssetId,
        bar1OffsetSec: input.bar1OffsetSec,
        createdBy: userId,
        createdAt: now,
      })
      .run();
    const values = {
      source: input.source,
      data,
      midiAssetId: input.midiAssetId,
      bar1OffsetSec: input.bar1OffsetSec,
      revisionId,
      updatedBy: userId,
      updatedAt: now,
    };
    db.insert(tempoMaps)
      .values({ songId, ...values })
      .onConflictDoUpdate({ target: tempoMaps.songId, set: values })
      .run();
    const grid = compileTempo({ map: input.map, bar1OffsetSec: input.bar1OffsetSec });
    const moved = moveMusicalMarkers(db, songId, grid, now);
    afterTimelineChange(db, songId, now);
    return { moved, revisionId };
  });
}

/** Removes the tempo map (revisions stay restorable). False when there was none. */
export function deleteSongTempo(db: Db, songId: string, now: number = Date.now()): boolean {
  return db.transaction(() => {
    const removed = db.delete(tempoMaps).where(eq(tempoMaps.songId, songId)).run().changes;
    if (removed === 0) return false;
    moveMusicalMarkers(db, songId, null, now);
    afterTimelineChange(db, songId, now);
    return true;
  });
}

export const TEMPO_REVISIONS_LIMIT = 100;

function toRevision(r: RevisionRow, by: string | null, file: string | null): TempoRevision[] {
  const map = parseMap(r.data);
  if (!map) return [];
  return [
    {
      id: r.id,
      map,
      bar1OffsetSec: r.bar1OffsetSec,
      source: r.source,
      midiFileName: file,
      createdByName: by,
      createdAt: r.createdAt,
    },
  ];
}

export function listSongTempoRevisions(db: Db, songId: string): TempoRevision[] {
  return db
    .select({ r: tempoMapRevisions, by: users.displayName, file: assets.originalFilename })
    .from(tempoMapRevisions)
    .leftJoin(users, eq(users.id, tempoMapRevisions.createdBy))
    .leftJoin(assets, eq(assets.id, tempoMapRevisions.midiAssetId))
    .where(eq(tempoMapRevisions.songId, songId))
    .orderBy(desc(tempoMapRevisions.createdAt), desc(tempoMapRevisions.id))
    .limit(TEMPO_REVISIONS_LIMIT)
    .all()
    .flatMap((x) => toRevision(x.r, x.by, x.file));
}

export function getTempoRevision(
  db: Db,
  songId: string,
  id: string,
): (TempoInput & { id: string }) | null {
  const r = db
    .select()
    .from(tempoMapRevisions)
    .where(and(eq(tempoMapRevisions.id, id), eq(tempoMapRevisions.songId, songId)))
    .get();
  const map = r && parseMap(r.data);
  if (!r || !map) return null;
  return {
    id: r.id,
    map,
    bar1OffsetSec: r.bar1OffsetSec,
    source: r.source,
    midiAssetId: r.midiAssetId,
  };
}

/** A MIDI file stored in blob storage, not yet referenced by an asset. */
export interface StoredMidiBlob {
  hash: string;
  sizeBytes: number;
}

/**
 * Step 1 of storing an uploaded MIDI file (small, already in memory; SPEC §7.2): the blob. An
 * unreferenced blob is freed by GC if step 2 never commits.
 */
export async function storeMidiBlob(
  db: Db,
  storage: StorageBackend,
  tmpDir: string,
  bytes: Uint8Array,
): Promise<StoredMidiBlob> {
  await fs.mkdir(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `midi-${uuidv7()}.mid`);
  await fs.writeFile(file, bytes);
  try {
    const hash = await sha256File(file);
    const blob = await storeFile(db, storage, file, hash);
    return { hash: blob.hash, sizeBytes: blob.sizeBytes };
  } finally {
    await fs.rm(file, { force: true });
  }
}

/**
 * Step 2: the ready `midi` asset rows (synchronous, so callers can run it inside their own
 * transaction with the tempo revision it belongs to). Returns the asset id.
 */
export function createMidiAssetRows(
  db: Db,
  blob: StoredMidiBlob,
  fileName: string,
  userId: string,
): string {
  return db.transaction(() => {
    const asset = createOriginalAsset(
      db,
      {
        kind: "midi",
        originalFilename: fileName,
        mimeType: "audio/midi",
        sizeBytes: blob.sizeBytes,
        originalHash: blob.hash,
        uploadedBy: userId,
      },
      blob,
    );
    setAssetStatus(db, asset.id, "ready");
    return asset.id;
  });
}
