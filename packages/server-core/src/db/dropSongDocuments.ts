import { releaseUnreferencedAssets } from "../content/trash";
import { recordEvent } from "../events/record";
import { getSetting, setSetting } from "../settings/registry";
import { enqueueBlobGc } from "../storage/blobGc";
import type { Db } from "./connection";
import { hasColumn } from "./convertMixTracks";

/**
 * M22 (SPEC §28.4): documents belong to projects only. Before the migration that drops
 * `documents.song_id`, the existing song documents are deleted with their versions (raw SQL, the
 * column is gone from the schema); their assets are released after the migrations by
 * {@link releaseDroppedDocumentAssets}, so the uploaders' usage drops and the blob GC frees the
 * files.
 */

const SYSTEM = "system" as const;
const REASON = "song documents removed";

interface SongDocumentRow {
  id: string;
  title: string;
  projectId: string;
  songId: string;
}

/**
 * Deletes every song document (live or in the Trash) in one transaction, writes
 * `document.purged` (system actor) per document and keeps the assets of their versions in
 * `migration.releaseAssets`. A no-op (null) once `documents.song_id` is gone. Returns the number
 * of documents deleted.
 */
export function dropSongDocuments(db: Db, now: number = Date.now()): number | null {
  const sql = db.$client;
  if (!hasColumn(sql, "documents", "song_id")) return null;
  return db.transaction(() => {
    const docs = sql
      .prepare(
        `SELECT id, title, project_id AS projectId, song_id AS songId
           FROM documents WHERE song_id IS NOT NULL ORDER BY created_at, id`,
      )
      .all() as SongDocumentRow[];
    if (docs.length === 0) return 0;
    const assetIds = (
      sql
        .prepare(
          `SELECT DISTINCT v.asset_id AS id FROM document_versions v
             JOIN documents d ON d.id = v.document_id
            WHERE d.song_id IS NOT NULL`,
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
    // Versions go by cascade.
    sql.prepare("DELETE FROM documents WHERE song_id IS NOT NULL").run();
    for (const d of docs)
      recordEvent(db, {
        action: "document.purged",
        actorType: SYSTEM,
        projectId: d.projectId,
        songId: d.songId,
        targetType: "document",
        targetId: d.id,
        details: { title: d.title, reason: REASON },
        ts: now,
      });
    const pending = new Set([...getSetting(db, "migration.releaseAssets"), ...assetIds]);
    setSetting(db, "migration.releaseAssets", [...pending], now);
    return docs.length;
  });
}

/**
 * After the migrations: releases the assets {@link dropSongDocuments} put aside (those nothing
 * else references lose their variants, which lowers the usage) and schedules a `blob.gc` job for
 * the released files, `graceMs` from now. Returns the bytes taken off the usage.
 */
export function releaseDroppedDocumentAssets(
  db: Db,
  graceMs: number,
  now: number = Date.now(),
): number {
  const ids = getSetting(db, "migration.releaseAssets");
  if (ids.length === 0) return 0;
  return db.transaction(() => {
    const hashes = new Set<string>();
    const freed = releaseUnreferencedAssets(db, ids, now, hashes);
    if (hashes.size > 0) enqueueBlobGc(db, [...hashes], graceMs, now);
    setSetting(db, "migration.releaseAssets", [], now);
    return freed;
  });
}
