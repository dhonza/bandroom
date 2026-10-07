import fs from "node:fs/promises";
import path from "node:path";
import { dbToGain, panGains, uuidv7 } from "@bandroom/shared";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getTrackVersionRow, systemMixTrack, userMixTrack, type TrackRow } from "../content/tracks";
import type { Db } from "../db/connection";
import { assets, songs, tracks, trackVersions } from "../db/schema";
import { enqueueJob } from "../jobs/queue";
import type { JobHandler } from "../jobs/types";
import { measureLoudness } from "./analysis";
import { assetProbe, createAsset, getAsset, setAssetProbe, setAssetStatus } from "./assets";
import { encodeOpus, resampleFilter } from "./encode";
import { readOggOpus } from "./ogg";
import { computePeaks } from "./peaks";
import { sha256File } from "../storage/hash";
import { ffmpegArgs, mediaTimeLimitMs, runTool, withTimeLimit } from "./tools";
import { getVariant, removeAllVariants } from "./variants";

/** Debounce after the last relevant change (SPEC §5.5). */
export const MIXDOWN_DELAY_MS = 60_000;
/**
 * Debounce after an imported version is ingested (SPEC §25.5): the importer's ingests run one
 * after another, so each song's mix should follow its own tracks rather than wait a minute.
 */
export const MIXDOWN_IMPORT_DELAY_MS = 10_000;
/**
 * Mixdowns outrank import ingests (`IMPORT_JOB_PRIORITY` −5) once due, and stay behind
 * interactive uploads (0), so a song imported early gets its mix while later songs still ingest.
 */
export const MIXDOWN_PRIORITY = -1;
/** Sums above this true peak get the limiter (SPEC §5.5: −1 dBTP). */
export const MIXDOWN_TRUE_PEAK_LIMIT_DB = -1;

/**
 * Schedules (or postpones) the song's auto-mix. One queued job per song via the dedupe key; a new
 * change moves its start time another `delayMs` (60 s) out.
 */
export function scheduleMixdown(
  db: Db,
  songId: string,
  now: number = Date.now(),
  delayMs: number = MIXDOWN_DELAY_MS,
): void {
  const key = `mixdown:${songId}`;
  const runAfter = now + delayMs;
  const updated = db.$client
    .prepare("UPDATE jobs SET run_after = ? WHERE dedupe_key = ? AND status = 'queued'")
    .run(runAfter, key).changes;
  if (updated > 0) return;
  const song = db
    .select({ projectId: songs.projectId })
    .from(songs)
    .where(eq(songs.id, songId))
    .get();
  enqueueJob(
    db,
    {
      type: "audio.mixdown",
      capability: "audio.mixdown",
      payload: { songId, projectId: song?.projectId ?? null },
      dedupeKey: key,
      priority: MIXDOWN_PRIORITY,
      runAfter,
    },
    now,
  );
}

/**
 * After a version's ingest (SPEC §5.5, §25.5): only the current version of its track changes the
 * mix (an imported stack ingests its older versions too), and imported versions use the short
 * debounce.
 */
export function scheduleMixdownAfterIngest(
  db: Db,
  songId: string,
  trackVersionId: string | null,
  now: number = Date.now(),
): void {
  const version = trackVersionId ? getTrackVersionRow(db, trackVersionId) : undefined;
  let target = songId;
  if (version) {
    const track = db
      .select({ currentVersionId: tracks.currentVersionId, songId: tracks.songId })
      .from(tracks)
      .where(eq(tracks.id, version.trackId))
      .get();
    if (track && track.currentVersionId !== version.id) return;
    // The track may have moved to another song while it was processing (SPEC §26.5).
    if (track) target = track.songId;
  }
  const delay = version?.source === "import" ? MIXDOWN_IMPORT_DELAY_MS : MIXDOWN_DELAY_MS;
  scheduleMixdown(db, target, now, delay);
}

export const MixdownPayloadSchema = z.object({
  songId: z.string(),
  projectId: z.string().nullable().default(null),
});
export type MixdownPayload = z.infer<typeof MixdownPayloadSchema>;
export type MixdownResult =
  | { status: "rendered"; inputs: number; limited: boolean }
  | { status: "removed" | "skipped"; reason: string };

interface MixInput {
  path: string;
  gain: number;
  pan: number;
  /** Channels of the stored file: 1 for mono and dual-mono sources, else 2. */
  channels: 1 | 2;
  /**
   * Pan law (SPEC §6.6): `mono` is equal power (−3 dB per side at centre), `stereo` the balance
   * law (unity at centre). Dual-mono sources are stored as one channel but use `stereo`.
   */
  law: "mono" | "stereo";
  offsetSamples: number;
}

/** The pan law of a source: true mono pans with equal power, dual-mono and stereo by balance. */
export function panLaw(probe: { channels: number; dualMono?: boolean } | null): "mono" | "stereo" {
  return probe?.channels === 1 && !probe.dualMono ? "mono" : "stereo";
}

/**
 * Channels of the file the mix reads: the probe describes the upload, but a dual-mono upload's
 * `flac` and `opus` hold one channel (SPEC §5.2); its kept `original` still has two.
 */
export function mixChannels(
  probe: { channels: number; dualMono?: boolean } | null,
  variant: string,
): 1 | 2 {
  if (probe?.channels === 1) return 1;
  return probe?.dualMono && variant !== "original" ? 1 : 2;
}

/** Removes the auto-mix (e.g. the band uploaded its own mix). */
export function removeAutoMix(db: Db, songId: string, now: number = Date.now()): boolean {
  const sys = systemMixTrack(db, songId);
  if (!sys) return false;
  for (const v of db.select().from(trackVersions).where(eq(trackVersions.trackId, sys.id)).all()) {
    removeAllVariants(db, v.assetId, now);
    db.update(trackVersions).set({ deletedAt: now }).where(eq(trackVersions.id, v.id)).run();
  }
  db.update(tracks)
    .set({ deletedAt: now, currentVersionId: null })
    .where(eq(tracks.id, sys.id))
    .run();
  return true;
}

/** Removes a render that never got attached: its variants (blob refs, usage) and the row. */
function discardAsset(db: Db, assetId: string): void {
  db.transaction(() => {
    removeAllVariants(db, assetId);
    db.delete(assets).where(eq(assets.id, assetId)).run();
  });
}

/**
 * Linear gain of one input: the track's default gain and the version's own gain (SPEC §25.6), both
 * in dB, so `version gain × default gain`.
 */
export function mixGain(defaultGainDb: number, versionGainDb: number): number {
  return dbToGain(defaultGainDb) * dbToGain(versionGainDb);
}

function eligibleTracks(db: Db, songId: string): TrackRow[] {
  return db
    .select()
    .from(tracks)
    .where(
      and(
        eq(tracks.songId, songId),
        eq(tracks.role, "track"),
        eq(tracks.isSystem, false),
        isNull(tracks.deletedAt),
      ),
    )
    .all()
    .filter((t) => !t.defaultMuted && dbToGain(t.defaultGainDb) > 0 && t.currentVersionId !== null);
}

/**
 * Builds the ffmpeg filter graph: per input resample → equal-power pan → gain → delay by the
 * version's timeline offset; then `amix` without normalization (SPEC §5.5).
 */
export function mixdownFilter(inputs: readonly MixInput[], resample: string): string {
  const chains = inputs.map((inp, i) => {
    const g = panGains(inp.pan, inp.law);
    // A one-channel file (mono or dual-mono) feeds both sides from its only channel.
    const right = inp.channels === 1 ? "c0" : "c1";
    const pan = `pan=stereo|c0=${(g.left * inp.gain).toFixed(6)}*c0|c1=${(g.right * inp.gain).toFixed(6)}*${right}`;
    const delay = inp.offsetSamples > 0 ? `,adelay=delays=${inp.offsetSamples}S:all=1` : "";
    return `[${i}:a]${resample},${pan}${delay}[a${i}]`;
  });
  const labels = inputs.map((_, i) => `[a${i}]`).join("");
  const mix =
    inputs.length === 1
      ? `${labels}anull[m]`
      : `${labels}amix=inputs=${inputs.length}:normalize=0:duration=longest[m]`;
  return [...chains, mix].join(";");
}

/** `audio.mixdown` (SPEC §5.5): renders the auto-mix onto the hidden system track. */
export const audioMixdownHandler: JobHandler<MixdownPayload, MixdownResult> = {
  type: "audio.mixdown",
  capability: "audio.mixdown",
  payloadSchema: MixdownPayloadSchema,
  async run(ctx, { songId }) {
    const { db, tools } = ctx;
    if (userMixTrack(db, songId)) {
      removeAutoMix(db, songId);
      return { status: "removed", reason: "song has an uploaded mix" };
    }

    const inputs: MixInput[] = [];
    let lengthSec = 0;
    for (const t of eligibleTracks(db, songId)) {
      const v = getTrackVersionRow(db, t.currentVersionId ?? "");
      const asset = v && getAsset(db, v.assetId);
      if (!v || !asset) continue;
      if (asset.status === "queued" || asset.status === "processing") {
        // Ingest completion schedules another mixdown.
        return { status: "skipped", reason: "inputs still processing" };
      }
      if (asset.status !== "ready") continue;
      // Full quality when there is any; Opus for versions whose full quality was removed (SPEC
      // §26.4), so they stay in the mix.
      const variant = ["flac", "original", "opus"].find((n) => getVariant(db, asset.id, n));
      if (!variant) continue;
      const probe = assetProbe(asset);
      lengthSec = Math.max(lengthSec, (probe?.durationSec ?? 0) + v.offsetSamples / 48_000);
      inputs.push({
        path: await ctx.input({ assetId: asset.id, variant }),
        gain: mixGain(t.defaultGainDb, v.gainDb),
        pan: t.defaultPan,
        channels: mixChannels(probe, variant),
        // Dual-mono sources are stored mono but were stereo: both channels, unity at centre.
        law: panLaw(probe),
        offsetSamples: v.offsetSamples,
      });
    }
    if (inputs.length === 0) {
      removeAutoMix(db, songId);
      return { status: "removed", reason: "no audible tracks" };
    }

    const signal = withTimeLimit(ctx.signal, mediaTimeLimitMs(lengthSec));
    ctx.progress(0.1, "render");
    const wav = path.join(ctx.tmpDir, "mix.wav");
    const graph = mixdownFilter(inputs, await resampleFilter(tools));
    await runTool(
      tools.ffmpeg,
      ffmpegArgs(
        ...inputs.flatMap((i) => ["-i", i.path]),
        "-filter_complex",
        graph,
        "-map",
        "[m]",
        "-ar",
        "48000",
        "-c:a",
        "pcm_f32le",
        wav,
      ),
      { signal },
    );

    // True-peak check; limit only if the sum clips (SPEC §5.5).
    let loudness = await measureLoudness(wav, tools, signal);
    let limited = false;
    let source = wav;
    if (loudness.truePeakDbtp !== null && loudness.truePeakDbtp > MIXDOWN_TRUE_PEAK_LIMIT_DB) {
      const out = path.join(ctx.tmpDir, "mix-limited.wav");
      // alimiter works on sample peaks: aim at −1.5 dBFS to keep inter-sample peaks under −1 dBTP.
      await runTool(
        tools.ffmpeg,
        ffmpegArgs(
          "-i",
          wav,
          "-af",
          "alimiter=limit=0.841:level=false:attack=5:release=50",
          "-c:a",
          "pcm_f32le",
          out,
        ),
        { signal },
      );
      source = out;
      limited = true;
      loudness = await measureLoudness(out, tools, signal);
    }
    ctx.progress(0.5, "encode");

    const { size } = await fs.stat(source);
    const asset = createAsset(db, {
      kind: "audio",
      originalFilename: "auto-mix.wav",
      mimeType: "audio/wav",
      sizeBytes: size,
      originalHash: await sha256File(source),
      uploadedBy: null, // counts toward the "system" usage (SPEC §15.1)
    });
    setAssetStatus(db, asset.id, "processing");
    try {
      const ref = (variant: string) => ({ assetId: asset.id, variant });
      let durationSamples = 0;
      for (const [variant, kbps] of [
        ["opus", 128],
        ["opus_low", 48],
      ] as const) {
        const out = path.join(ctx.tmpDir, `${variant}.opus`);
        await encodeOpus(source, out, { bitrateKbps: kbps, channels: 2, signal }, tools);
        const info = await readOggOpus(out);
        durationSamples = info.totalSamples;
        await ctx.output(ref(variant), out, {
          codec: "opus",
          bitrate: kbps,
          sampleRate: 48_000,
          channels: 2,
          preSkip: info.preSkip,
          durationSamples48k: info.totalSamples,
          decodedSamples: info.totalSamples,
        });
        const idx = path.join(ctx.tmpDir, `seek-${variant}.json`);
        await fs.writeFile(idx, JSON.stringify(info.seekIndex));
        await ctx.output(ref(`seekindex_${variant}`), idx, {
          for: variant,
          entries: info.seekIndex.length,
        });
      }
      const peaksOut = path.join(ctx.tmpDir, "peaks.dat");
      const peaks = await computePeaks(
        source,
        peaksOut,
        { sampleRate: 48_000, channels: 2, signal },
        tools,
      );
      await ctx.output(ref("peaks"), peaksOut, {
        format: "audiowaveform-dat-v1",
        bits: 8,
        samplesPerPixel: 256,
        sampleRate: 48_000,
        pixels: peaks.pixels,
        overview: peaks.overview,
      });
      setAssetProbe(db, asset.id, {
        container: "wav",
        codec: "pcm_f32le",
        lossless: false, // derived render; only lossy variants are kept (SPEC §5.5)
        sampleRate: 48_000,
        channels: 2,
        sampleFormat: "flt",
        bitDepth: 0,
        isFloat: true,
        durationSamples,
        durationSec: durationSamples / 48_000,
        tags: {},
        timeReference: null,
        dualMono: false,
        loudness,
      });
      setAssetStatus(db, asset.id, "ready");

      // Attach to the hidden system mix track, replacing the previous auto-mix.
      const now = Date.now();
      db.transaction(() => {
        let sys = systemMixTrack(db, songId);
        if (!sys) {
          sys = db
            .insert(tracks)
            .values({
              id: uuidv7(now),
              songId,
              name: "Auto mix",
              role: "mix",
              isSystem: true,
              sortOrder: -1,
              createdAt: now,
            })
            .returning()
            .get();
        }
        const previous = db
          .select()
          .from(trackVersions)
          .where(and(eq(trackVersions.trackId, sys.id), isNull(trackVersions.deletedAt)))
          .all();
        const number = previous.reduce((m, v) => Math.max(m, v.number), 0) + 1;
        const version = db
          .insert(trackVersions)
          .values({
            id: uuidv7(now),
            trackId: sys.id,
            number,
            stackOrder: number,
            assetId: asset.id,
            source: "render",
            isAutoMix: true,
            createdAt: now,
          })
          .returning()
          .get();
        db.update(tracks).set({ currentVersionId: version.id }).where(eq(tracks.id, sys.id)).run();
        for (const old of previous) {
          removeAllVariants(db, old.assetId, now);
          db.update(trackVersions)
            .set({ deletedAt: now })
            .where(eq(trackVersions.id, old.id))
            .run();
        }
      });
    } catch (err) {
      // Not attached to the system track yet: free its blobs and system usage (review M10).
      discardAsset(db, asset.id);
      throw err;
    }
    ctx.progress(1, "ready");
    return { status: "rendered", inputs: inputs.length, limited };
  },
};
