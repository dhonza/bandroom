import { bounceTracks, type BounceRequest } from "@bandroom/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/connection";
import { jobs, tracks } from "../db/schema";
import { recordEvent } from "../events/record";
import { enqueueJob } from "../jobs/queue";
import { assetProbe, createAsset, getAsset, type AssetRow } from "../media/assets";
import type { BounceInput, BouncePayload } from "../media/bounce";
import type { SongRow } from "./access";
import { createSongRow } from "./songs";
import {
  createTrackWithVersion,
  getTrackVersionRow,
  type TrackRow,
  type TrackVersionRow,
} from "./tracks";

/** Bytes per second of the rendered file: 48 kHz, stereo, 24-bit PCM (SPEC §5.5). */
export const BOUNCE_WAV_BYTES_PER_SEC = 48_000 * 2 * 3;

export type BouncePlan =
  | { ok: true; inputs: BounceInput[]; lengthSec: number; estimateBytes: number }
  | { ok: false; reason: "invalid" | "silent" };

/**
 * Checks a bounce request against the song (SPEC §5.5) and picks what to render: every named
 * track must be a live track of the song, its version a live version of that track with a ready
 * file. Mute, solo and faders follow the engine ({@link bounceTracks}); a track missing from the
 * personal mix plays its default mix. The size estimate is the length as a 24-bit stereo WAV,
 * the original the render becomes (its FLAC and Opus are covered by the quota overhead).
 */
export function planBounce(
  db: Db,
  songId: string,
  req: Pick<BounceRequest, "mix" | "versions">,
): BouncePlan {
  const songTracks = new Map(
    db
      .select()
      .from(tracks)
      .where(and(eq(tracks.songId, songId), isNull(tracks.deletedAt)))
      .all()
      .map((t) => [t.id, t]),
  );
  const chosen = new Map<string, { version: TrackVersionRow; asset: AssetRow }>();
  for (const [trackId, versionId] of Object.entries(req.versions)) {
    const version = getTrackVersionRow(db, versionId);
    const asset = version && getAsset(db, version.assetId);
    if (!songTracks.has(trackId) || version?.trackId !== trackId || asset?.status !== "ready")
      return { ok: false, reason: "invalid" };
    chosen.set(trackId, { version, asset });
  }
  const audible = bounceTracks(req.versions, req.mix, (id) => {
    const t = songTracks.get(id);
    return t && { gainDb: t.defaultGainDb, pan: t.defaultPan, mute: t.defaultMuted, solo: false };
  });
  if (audible.length === 0) return { ok: false, reason: "silent" };
  let lengthSec = 0;
  const inputs = audible.map((b): BounceInput => {
    const c = chosen.get(b.trackId);
    if (!c) throw new Error("unreachable: audible track without a version");
    const durationSec = assetProbe(c.asset)?.durationSec ?? 0;
    lengthSec = Math.max(lengthSec, c.version.offsetSamples / 48_000 + durationSec);
    return {
      trackId: b.trackId,
      versionId: c.version.id,
      assetId: c.asset.id,
      faderDb: b.gainDb,
      versionGainDb: c.version.gainDb,
      pan: b.pan,
      offsetSamples: c.version.offsetSamples,
    };
  });
  return {
    ok: true,
    inputs,
    lengthSec,
    estimateBytes: Math.ceil(lengthSec * BOUNCE_WAV_BYTES_PER_SEC),
  };
}

export interface CreatedBounce {
  song: SongRow;
  track: TrackRow;
  version: TrackVersionRow;
  assetId: string;
}

/**
 * Creates the bounce (SPEC §5.5) in one transaction: a song titled `title` right after the
 * source, one track named after it whose only version (`source: render`) points to a queued
 * asset uploaded by the user (it counts toward their quota), the `audio.bounce` job and the
 * `song.bounced` event. The worker renders the file, then the normal ingest runs.
 */
export function createBounce(
  db: Db,
  input: {
    source: SongRow;
    title: string;
    userId: string;
    inputs: BounceInput[];
    request: Pick<BounceRequest, "mix" | "versions">;
    event?: { sessionId?: string | null; ip?: string | null; userAgent?: string | null };
  },
  now: number = Date.now(),
): CreatedBounce {
  return db.transaction(() => {
    const song = createSongRow(
      db,
      {
        projectId: input.source.projectId,
        title: input.title,
        createdBy: input.userId,
        after: input.source,
      },
      now,
    );
    const asset = createAsset(
      db,
      {
        kind: "audio",
        originalFilename: `${input.title.slice(0, 200)}.wav`,
        mimeType: "audio/wav",
        sizeBytes: 0, // set when rendered
        originalHash: "",
        uploadedBy: input.userId,
      },
      now,
    );
    const { track, version } = createTrackWithVersion(
      db,
      {
        songId: song.id,
        name: input.title,
        assetId: asset.id,
        uploadedBy: input.userId,
        source: "render",
      },
      now,
    );
    const payload: BouncePayload = {
      assetId: asset.id,
      projectId: song.projectId,
      songId: song.id,
      trackVersionId: version.id,
      sourceSongId: input.source.id,
      userId: input.userId,
      inputs: input.inputs,
    };
    enqueueBounceJob(db, payload, input.userId, now);
    recordEvent(db, {
      ts: now,
      actorUserId: input.userId,
      sessionId: input.event?.sessionId ?? null,
      ip: input.event?.ip ?? null,
      userAgent: input.event?.userAgent ?? null,
      action: "song.bounced",
      projectId: song.projectId,
      songId: song.id,
      targetType: "song",
      targetId: song.id,
      details: {
        sourceSongId: input.source.id,
        title: song.title,
        versions: input.request.versions,
        mix: input.request.mix.tracks,
      },
    });
    return { song, track, version, assetId: asset.id };
  });
}

function enqueueBounceJob(db: Db, payload: BouncePayload, createdBy: string, now?: number): void {
  enqueueJob(
    db,
    {
      type: "audio.bounce",
      capability: "audio.bounce",
      payload,
      dedupeKey: `bounce:${payload.assetId}`,
      priority: 0,
      createdBy,
    },
    now,
  );
}

/**
 * Retrying a bounce whose render failed (no `original` yet): queues `audio.bounce` again with
 * the request of its last job. False when the asset never had a bounce job.
 */
export function retryBounce(db: Db, assetId: string, createdBy: string): boolean {
  const last = db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.type, "audio.bounce"), eq(jobs.dedupeKey, `bounce:${assetId}`)))
    .orderBy(jobs.createdAt)
    .all()
    .at(-1);
  if (!last) return false;
  enqueueBounceJob(db, JSON.parse(last.payload) as BouncePayload, createdBy);
  return true;
}
