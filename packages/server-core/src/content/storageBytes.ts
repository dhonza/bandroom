import type { Db } from "../db/connection";

/**
 * Storage sizes (SPEC §28.6): the bytes of an item are the sizes of the stored files (every
 * variant) of every asset under it, each file counted once per item. Items in the Trash are left
 * out; files shared with other items count for each of them.
 * - version: its asset; track: its versions; song: its tracks and tempo MIDI files;
 *   project: its songs, documents and image.
 * Each function is one grouped query; items without files are missing from the map (0 bytes).
 */

/** Live track versions of live tracks of live songs, as `(item, asset_id)` for an item column. */
const SONG_TRACK_ASSETS = (item: string, where: string) => `
  SELECT ${item} AS item, v.asset_id AS asset_id
    FROM track_versions v
    JOIN tracks t ON t.id = v.track_id
    JOIN songs s ON s.id = t.song_id
   WHERE ${where} AND s.deleted_at IS NULL AND t.deleted_at IS NULL AND v.deleted_at IS NULL`;

/** Tempo MIDI files (current map and history) of live songs. */
const SONG_MIDI_ASSETS = (item: string, where: string) => `
  SELECT ${item} AS item, m.midi_asset_id AS asset_id
    FROM tempo_maps m JOIN songs s ON s.id = m.song_id
   WHERE ${where} AND s.deleted_at IS NULL AND m.midi_asset_id IS NOT NULL
  UNION ALL
  SELECT ${item} AS item, r.midi_asset_id AS asset_id
    FROM tempo_map_revisions r JOIN songs s ON s.id = r.song_id
   WHERE ${where} AND s.deleted_at IS NULL AND r.midi_asset_id IS NOT NULL`;

/** Sums the distinct stored files per item of an `(item, asset_id)` query. */
const SUM_BY_ITEM = (itemAssets: string) => `
  WITH item_assets AS (${itemAssets}),
       item_blobs AS (
         SELECT DISTINCT ia.item, av.blob_hash
           FROM item_assets ia JOIN asset_variants av ON av.asset_id = ia.asset_id)
  SELECT ib.item AS id, COALESCE(SUM(b.size_bytes), 0) AS bytes
    FROM item_blobs ib JOIN blobs b ON b.hash = ib.blob_hash
   GROUP BY ib.item`;

function run(db: Db, sql: string, params: unknown[]): Map<string, number> {
  const rows = db.$client.prepare(sql).all(...params) as { id: string; bytes: number }[];
  return new Map(rows.map((r) => [r.id, r.bytes]));
}

/** Bytes per project (songs, documents and image). */
export function bytesByProject(db: Db, projectIds: readonly string[]): Map<string, number> {
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return new Map();
  const list = ids.map(() => "?").join(", ");
  const inSongs = `s.project_id IN (${list})`;
  const sql = SUM_BY_ITEM(`
    ${SONG_TRACK_ASSETS("s.project_id", inSongs)}
    UNION ALL ${SONG_MIDI_ASSETS("s.project_id", inSongs)}
    UNION ALL
    SELECT d.project_id AS item, dv.asset_id AS asset_id
      FROM document_versions dv JOIN documents d ON d.id = dv.document_id
     WHERE d.project_id IN (${list}) AND d.deleted_at IS NULL AND dv.deleted_at IS NULL
    UNION ALL
    SELECT p.id AS item, p.image_asset_id AS asset_id
      FROM projects p WHERE p.id IN (${list}) AND p.image_asset_id IS NOT NULL`);
  // One copy of the ids per IN list: tracks, MIDI (map, history), documents, image.
  return run(db, sql, [...ids, ...ids, ...ids, ...ids, ...ids]);
}

/** Bytes per live song of a project (tracks and tempo MIDI). */
export function bytesBySong(db: Db, projectId: string): Map<string, number> {
  const where = "s.project_id = ?";
  return run(
    db,
    SUM_BY_ITEM(`${SONG_TRACK_ASSETS("s.id", where)} UNION ALL ${SONG_MIDI_ASSETS("s.id", where)}`),
    [projectId, projectId, projectId],
  );
}

/** Bytes of one song (tracks and tempo MIDI). */
export function songBytes(db: Db, songId: string): number {
  const where = "s.id = ?";
  return (
    run(
      db,
      SUM_BY_ITEM(
        `${SONG_TRACK_ASSETS("s.id", where)} UNION ALL ${SONG_MIDI_ASSETS("s.id", where)}`,
      ),
      [songId, songId, songId],
    ).get(songId) ?? 0
  );
}

/** Bytes per live track of a song (all its versions). */
export function bytesByTrack(db: Db, songId: string): Map<string, number> {
  return run(db, SUM_BY_ITEM(SONG_TRACK_ASSETS("t.id", "s.id = ?")), [songId]);
}
