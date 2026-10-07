import type { Processing } from "@bandroom/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/connection";
import { assets, jobs, songs, tracks, trackVersions } from "../db/schema";

const EMPTY: Processing = { queued: 0, processing: 0, failed: 0, progress: null, mix: null };

function assetIdOf(payload: string): string | null {
  try {
    const p = JSON.parse(payload) as { assetId?: unknown; songId?: unknown };
    return typeof p.assetId === "string" ? p.assetId : null;
  } catch {
    return null;
  }
}

function songIdOf(payload: string): string | null {
  try {
    const p = JSON.parse(payload) as { songId?: unknown };
    return typeof p.songId === "string" ? p.songId : null;
  } catch {
    return null;
  }
}

/**
 * Media work per song (SPEC §25.3): counts of current track versions (incl. the automatic mix)
 * whose asset is queued, processing or failed, the mean progress of the running jobs, and the
 * automatic mix's queued or running job. Songs without any work are left out. `projectId` limits
 * it to one project (song lists); otherwise it covers every live song (filtered by the caller).
 */
export function processingBySong(db: Db, projectId?: string): Map<string, Processing> {
  const rows = db
    .select({ songId: tracks.songId, assetId: assets.id, status: assets.status })
    .from(tracks)
    .innerJoin(songs, eq(songs.id, tracks.songId))
    .innerJoin(trackVersions, eq(trackVersions.id, tracks.currentVersionId))
    .innerJoin(assets, eq(assets.id, trackVersions.assetId))
    .where(
      and(
        isNull(tracks.deletedAt),
        isNull(songs.deletedAt),
        isNull(trackVersions.deletedAt),
        inArray(assets.status, ["queued", "processing", "failed"]),
        projectId === undefined ? undefined : eq(songs.projectId, projectId),
      ),
    )
    .all();
  const running = db
    .select({
      type: jobs.type,
      payload: jobs.payload,
      progress: jobs.progress,
      status: jobs.status,
    })
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ["queued", "running"]),
        inArray(jobs.type, ["audio.ingest", "audio.mixdown"]),
      ),
    )
    .all();
  const progressByAsset = new Map<string, number>();
  const mixBySong = new Map<string, "queued" | "processing">();
  for (const j of running) {
    if (j.type === "audio.mixdown") {
      const songId = songIdOf(j.payload);
      if (songId && mixBySong.get(songId) !== "processing")
        mixBySong.set(songId, j.status === "running" ? "processing" : "queued");
    } else if (j.status === "running") {
      const assetId = assetIdOf(j.payload);
      if (assetId) progressByAsset.set(assetId, j.progress);
    }
  }

  const out = new Map<string, Processing>();
  const progressSums = new Map<string, { sum: number; n: number }>();
  const entry = (songId: string): Processing => {
    let e = out.get(songId);
    if (!e) {
      e = { ...EMPTY };
      out.set(songId, e);
    }
    return e;
  };
  for (const r of rows) {
    const e = entry(r.songId);
    if (r.status === "failed") e.failed++;
    else if (r.status === "processing" || progressByAsset.has(r.assetId)) {
      e.processing++;
      const p = progressByAsset.get(r.assetId) ?? 0;
      const s = progressSums.get(r.songId) ?? { sum: 0, n: 0 };
      progressSums.set(r.songId, { sum: s.sum + p, n: s.n + 1 });
    } else e.queued++;
  }
  for (const [songId, mix] of mixBySong) {
    if (projectId !== undefined && !out.has(songId)) {
      const song = db
        .select({ projectId: songs.projectId, deletedAt: songs.deletedAt })
        .from(songs)
        .where(eq(songs.id, songId))
        .get();
      if (song?.projectId !== projectId || song.deletedAt !== null) continue;
    }
    entry(songId).mix = mix;
  }
  for (const [songId, s] of progressSums) {
    const e = out.get(songId);
    if (e) e.progress = s.sum / s.n;
  }
  return out;
}

export function noProcessing(): Processing {
  return { ...EMPTY };
}
