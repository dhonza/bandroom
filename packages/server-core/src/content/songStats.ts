import type { SongStats } from "@bandroom/shared";
import type { Db } from "../db/connection";

/**
 * The song list's length and mono/stereo mark (SPEC §11.2) for every live song of a project, over
 * the current versions of its live tracks whose files are ready:
 * - `durationSec`: where the longest of them ends on the timeline (its `offsetSamples` start plus
 *   the length of its Opus), i.e. the song length the Player shows;
 * - `channels`: how many play stereo and how many mono, by the channels of the Opus that plays
 *   (a dual-mono source plays mono).
 * One query; songs without ready audio are missing from the map.
 */
export function songStatsBySong(db: Db, projectId: string): Map<string, SongStats> {
  const rows = db.$client
    .prepare(
      `SELECT t.song_id AS songId, v.offset_samples AS offset,
              COALESCE(o.meta, l.meta) AS meta
         FROM tracks t
         JOIN songs s ON s.id = t.song_id
         JOIN track_versions v ON v.id = t.current_version_id
         JOIN assets a ON a.id = v.asset_id
         LEFT JOIN asset_variants o ON o.asset_id = a.id AND o.variant = 'opus'
         LEFT JOIN asset_variants l ON l.asset_id = a.id AND l.variant = 'opus_low'
        WHERE s.project_id = ? AND s.deleted_at IS NULL AND t.deleted_at IS NULL
          AND v.deleted_at IS NULL AND a.status = 'ready'
          AND (o.asset_id IS NOT NULL OR l.asset_id IS NOT NULL)`,
    )
    .all(projectId) as { songId: string; offset: number; meta: string }[];
  const stats = new Map<string, SongStats>();
  for (const r of rows) {
    const meta = parseMeta(r.meta);
    const frames = typeof meta.durationSamples48k === "number" ? meta.durationSamples48k : 0;
    const mono = meta.channels === 1;
    const s = stats.get(r.songId) ?? { durationSec: 0, channels: { stereo: 0, mono: 0 } };
    s.durationSec = Math.max(s.durationSec, (r.offset + frames) / 48_000);
    if (mono) s.channels.mono += 1;
    else s.channels.stereo += 1;
    stats.set(r.songId, s);
  }
  return stats;
}

function parseMeta(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
