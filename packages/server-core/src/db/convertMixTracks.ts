import { SongTitleSchema } from "@bandroom/shared";
import { createSongRow } from "../content/songs";
import { purgeTrashItems } from "../content/trash";
import { recordEvent } from "../events/record";
import { getSetting, setSetting } from "../settings/registry";
import type { Db, Sqlite } from "./connection";
import { runMigrations } from "./migrate";

/**
 * M21 data conversion (SPEC §27.2): tracks lose their roles and the server's automatic mix goes.
 * It must run before migration 0017 drops `tracks.role`, `tracks.is_system` and
 * `track_versions.is_auto_mix`, so it reads them with raw SQL.
 */

export interface MixConversionResult {
  /** Mix tracks moved into new songs. */
  movedTracks: number;
  /** Hidden auto-mix tracks soft-deleted (purged after the migrations). */
  autoMixTracks: number;
  /** Queued or running `audio.mixdown` jobs cancelled. */
  cancelledJobs: number;
}

const SYSTEM = "system" as const;

/** Whether a table has a column (`PRAGMA table_info`). */
export function hasColumn(sqlite: Sqlite, table: string, column: string): boolean {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

interface MixTrackRow {
  id: string;
  name: string;
  songId: string;
  projectId: string;
  title: string;
  subtitle: string;
  key: string;
  downloadPolicy: string;
  songCreatedBy: string | null;
  createdBy: string | null;
}

/** "‹title› (mix)", "‹title› (mix 2)", … within the song title limit. */
function mixSongTitle(title: string, index: number): string {
  const suffix = index === 0 ? " (mix)" : ` (mix ${index + 1})`;
  const max = 200 - suffix.length;
  const base = title.trim().slice(0, max).trim();
  return SongTitleSchema.parse(`${base}${suffix}`);
}

/**
 * Converts the old mix model (SPEC §27.2), once, in one transaction; a no-op (null) when
 * `tracks.role` is gone already.
 * - A live `mix` track in a live song that also has other live tracks moves, with its versions and
 *   the comments on it, into a new song "‹title› (mix)" in the same project; the source song's
 *   grants are copied. Songs with only mix tracks stay as they are.
 * - Hidden auto-mix tracks are soft-deleted and listed in `migration.purgeTracks`, for
 *   {@link purgeConvertedAutoMixes} after the migrations.
 * - Queued or running `audio.mixdown` jobs are cancelled (no handler runs them any more).
 */
export function convertMixTracks(db: Db, now: number = Date.now()): MixConversionResult | null {
  const sql = db.$client;
  if (!hasColumn(sql, "tracks", "role")) return null;
  return db.transaction(() => {
    const candidates = sql
      .prepare(
        `SELECT t.id, t.name, t.created_by AS createdBy, s.id AS songId, s.project_id AS projectId,
                s.title, s.subtitle, s.key, s.download_policy AS downloadPolicy,
                s.created_by AS songCreatedBy
           FROM tracks t
           JOIN songs s ON s.id = t.song_id
           JOIN projects p ON p.id = s.project_id
          WHERE t.role = 'mix' AND t.is_system = 0 AND t.deleted_at IS NULL
            AND s.deleted_at IS NULL AND p.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM tracks o
                         WHERE o.song_id = t.song_id AND o.role <> 'mix' AND o.is_system = 0
                           AND o.deleted_at IS NULL)
          ORDER BY s.id, t.sort_order, t.created_at, t.id`,
      )
      .all() as MixTrackRow[];

    const perSong = new Map<string, number>();
    for (const t of candidates) {
      const index = perSong.get(t.songId) ?? 0;
      perSong.set(t.songId, index + 1);
      const song = createSongRow(
        db,
        {
          projectId: t.projectId,
          title: mixSongTitle(t.title, index),
          subtitle: t.subtitle,
          key: t.key,
          createdBy: t.createdBy ?? t.songCreatedBy,
        },
        now,
      );
      // Same download rule as the source (visibility comes from the copied grants).
      sql
        .prepare("UPDATE songs SET download_policy = ? WHERE id = ?")
        .run(t.downloadPolicy, song.id);
      sql
        .prepare("UPDATE tracks SET song_id = ?, sort_order = 0, role = 'track' WHERE id = ?")
        .run(song.id, t.id);
      // The comments on the track, and the replies to them, go along.
      sql
        .prepare(
          `UPDATE comments SET song_id = ?
            WHERE track_id = ?
               OR parent_id IN (SELECT id FROM comments WHERE track_id = ?)`,
        )
        .run(song.id, t.id, t.id);
      const grants = sql
        .prepare(
          `INSERT INTO song_grants (song_id, user_id, role, granted_by, granted_at)
           SELECT ?, user_id, role, granted_by, ? FROM song_grants WHERE song_id = ?
           RETURNING user_id AS userId, role`,
        )
        .all(song.id, now, t.songId) as { userId: string; role: string }[];

      const scope = { actorType: SYSTEM, projectId: t.projectId, songId: song.id, ts: now };
      recordEvent(db, {
        ...scope,
        action: "song.created",
        targetType: "song",
        targetId: song.id,
        details: { title: song.title, converted: "mix", sourceSongId: t.songId },
      });
      recordEvent(db, {
        ...scope,
        action: "track.moved",
        targetType: "track",
        targetId: t.id,
        details: {
          name: t.name,
          fromSongId: t.songId,
          fromProjectId: t.projectId,
          converted: "mix",
        },
      });
      for (const g of grants)
        recordEvent(db, {
          ...scope,
          action: "grant.changed",
          targetType: "user",
          targetId: g.userId,
          details: { scope: "song", before: null, after: g.role, reason: "mix-converted" },
        });
    }

    // The automatic mix: every hidden system track (live or already in the Trash).
    const autoMix = (
      sql.prepare("SELECT id FROM tracks WHERE is_system = 1").all() as { id: string }[]
    ).map((r) => r.id);
    if (autoMix.length > 0) {
      sql
        .prepare("UPDATE tracks SET deleted_at = COALESCE(deleted_at, ?) WHERE is_system = 1")
        .run(now);
      const pending = new Set([...getSetting(db, "migration.purgeTracks"), ...autoMix]);
      setSetting(db, "migration.purgeTracks", [...pending], now);
    }

    const cancelledJobs = sql
      .prepare(
        `UPDATE jobs SET status = 'cancelled', locked_by = NULL, locked_until = NULL,
                finished_at = ?, error = 'automatic mix removed (M21)'
          WHERE type = 'audio.mixdown' AND status IN ('queued', 'running')`,
      )
      .run(now).changes;

    return { movedTracks: candidates.length, autoMixTracks: autoMix.length, cancelledJobs };
  });
}

/**
 * Purges the auto-mix tracks {@link convertMixTracks} put aside (after the migrations): the Trash
 * purge removes them with their versions and releases their assets and blob references (the files
 * go with the daily blob GC). Returns the number of tracks purged.
 */
export function purgeConvertedAutoMixes(db: Db, now: number = Date.now()): number {
  const ids = getSetting(db, "migration.purgeTracks");
  if (ids.length === 0) return 0;
  return db.transaction(() => {
    const r = purgeTrashItems(db, { songs: [], tracks: ids, versions: [] }, now);
    for (const p of r.purged)
      recordEvent(db, {
        action: "track.purged",
        actorType: SYSTEM,
        projectId: p.projectId,
        songId: p.songId,
        targetType: "track",
        targetId: p.id,
        details: { name: p.name, auto: true, reason: "auto-mix removed" },
        ts: now,
      });
    setSetting(db, "migration.purgeTracks", [], now);
    return r.purged.length;
  });
}

/**
 * The server's migration path (server start and `bandroom migrate`): the M21 conversion while the
 * old columns exist, the Drizzle migrations, then the purge of the old automatic mixes.
 */
export function migrateDatabase(
  db: Db,
  migrationsFolder: string,
  now: number = Date.now(),
): { conversion: MixConversionResult | null; purgedAutoMixes: number } {
  const conversion = convertMixTracks(db, now);
  runMigrations(db, migrationsFolder);
  return { conversion, purgedAutoMixes: purgeConvertedAutoMixes(db, now) };
}
