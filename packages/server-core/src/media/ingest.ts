import fs from "node:fs/promises";
import path from "node:path";
import type { AudioQuality } from "@bandroom/shared";
import { z } from "zod";
import { archiveVersionsOfAssets, assetLosslessRemoved } from "../content/lossless";
import { recordEvent } from "../events/record";
import { PermanentJobError, type JobContext, type JobHandler } from "../jobs/types";
import { getSetting } from "../settings/registry";
import { audioMd5, detectDualMono, measureLoudness } from "./analysis";
import { assetIngestOptions, getAsset, setAssetProbe, setAssetStatus } from "./assets";
import { encodeFlac, encodeOpus, encodeWavPack } from "./encode";
import { flacSeekIndex } from "./flacIndex";
import { opusKbpsFor } from "./opusRates";
import { readOggOpus } from "./ogg";
import { computePeaks } from "./peaks";
import { probeAudio, UnsupportedMediaError, type Probe } from "./probe";
import { mediaTimeLimitMs, PROBE_TIME_LIMIT_MS, withTimeLimit } from "./tools";
import { removeVariant } from "./variants";
import { buildWavMeta, NotRiffWaveError } from "./wav";

export const AudioIngestPayloadSchema = z.object({
  assetId: z.string(),
  /** For SSE fan-out (permission filtering). */
  projectId: z.string().nullable().default(null),
  songId: z.string().nullable().default(null),
  trackVersionId: z.string().nullable().default(null),
});
export type AudioIngestPayload = z.infer<typeof AudioIngestPayloadSchema>;

export interface AudioIngestResult {
  lossless: boolean;
  dualMono: boolean;
  originalKept: boolean;
  variants: string[];
  /** Converted to lossy on upload (SPEC §28.2): the original is gone, the versions archived. */
  lossyOnly?: boolean;
}

/** Expected sample count after resampling to 48 kHz (SPEC §5.3 step 5). */
export function durationSamples48k(sourceSamples: number, sourceRate: number): number {
  return Math.round((sourceSamples * 48_000) / sourceRate);
}

/** Integer PCM up to 24 bit is stored as verified-lossless FLAC; floats and 32-bit ints are not. */
export function isLosslessFlacCandidate(p: Probe): boolean {
  return p.lossless && !p.isFloat && p.bitDepth > 0 && p.bitDepth <= 24;
}

/**
 * 32-bit float sources are stored as verified-lossless WavPack (DECISIONS 2026-10-09); their FLAC
 * is only near-lossless 24-bit, for playback. 64-bit float stays as the original (WavPack has no
 * double precision).
 */
export function isWavPackCandidate(p: Probe): boolean {
  return p.lossless && p.isFloat && /^flt/.test(p.sampleFormat);
}

async function writeJson(ctx: JobContext, name: string, data: unknown): Promise<string> {
  const file = path.join(ctx.tmpDir, name);
  await fs.writeFile(file, JSON.stringify(data));
  return file;
}

/**
 * `audio.ingest` (SPEC §5.3): probe, classify, dual-mono detection, FLAC (+ wavmeta, MD5
 * verification; WavPack for float sources), Opus high/low with pre-skip and exact 48 kHz length, seek indexes, peaks and
 * loudness. The worker runs one job at a time, and every tool runs niced with one thread.
 */
export const audioIngestHandler: JobHandler<
  AudioIngestPayload,
  AudioIngestResult | { skipped: string }
> = {
  type: "audio.ingest",
  capability: "audio.ingest",
  payloadSchema: AudioIngestPayloadSchema,
  async run(ctx, payload) {
    const { db, tools } = ctx;
    const assetId = payload.assetId;
    const asset = getAsset(db, assetId);
    if (!asset) throw new PermanentJobError(`Asset ${assetId} not found`);
    // Lossy on upload and the Opus preset (SPEC §28.2).
    const options = assetIngestOptions(asset);
    const lossyOnly = options.lossyOnly;
    // Never recreate full-quality files that were removed on purpose (SPEC §26.4); the asset
    // keeps its Opus and peaks and stays ready.
    if (assetLosslessRemoved(db, assetId)) return { skipped: "full quality was removed" };
    setAssetStatus(db, assetId, "processing");
    const variants: string[] = [];
    const ref = (variant: string) => ({ assetId, variant });
    const src = await ctx.input(ref("original"));

    // 1–3: probe, classify, dual-mono.
    ctx.progress(0.02, "probe");
    let probe: Probe;
    try {
      probe = await probeAudio(src, tools, withTimeLimit(ctx.signal, PROBE_TIME_LIMIT_MS));
    } catch (err) {
      if (err instanceof UnsupportedMediaError) throw new PermanentJobError(err.message);
      throw err;
    }
    // Every later tool run shares one budget sized by the duration (a hung ffmpeg must not block
    // the single worker forever).
    const signal = withTimeLimit(ctx.signal, mediaTimeLimitMs(probe.durationSec));
    const dualMono =
      probe.lossless && probe.channels === 2 ? await detectDualMono(src, 2, tools, signal) : false;
    probe = { ...probe, dualMono };
    setAssetProbe(db, assetId, probe);
    ctx.progress(0.1, "classified");

    const playbackChannels: 1 | 2 = dualMono || probe.channels === 1 ? 1 : 2;
    let originalKept = true;
    // Best full-quality source for the derived variants: the FLAC if we made one.
    let bestSource = src;

    // 4: lossless storage variant (none when converting to lossy on upload).
    if (probe.lossless && !lossyOnly) {
      if (/wav/.test(probe.container) && /^pcm_/.test(probe.codec)) {
        try {
          const meta = await buildWavMeta(src);
          const f = path.join(ctx.tmpDir, "wavmeta.bin");
          await fs.writeFile(f, meta);
          await ctx.output(ref("wavmeta"), f, { bytes: meta.length });
          variants.push("wavmeta");
        } catch (err) {
          if (!(err instanceof NotRiffWaveError)) throw err;
          ctx.log(`wavmeta skipped: ${err.message}`);
        }
      }
      const verifiable = isLosslessFlacCandidate(probe);
      const flacTmp = path.join(ctx.tmpDir, "audio.flac");
      const { bitDepth } = await encodeFlac(
        src,
        flacTmp,
        { bitDepth: probe.bitDepth, nearLossless: !verifiable, mono: dualMono, signal },
        tools,
      );
      ctx.progress(0.3, "flac");

      let verified = false;
      if (verifiable) {
        const a = await audioMd5(src, { leftOnly: dualMono, signal }, tools);
        const b = await audioMd5(flacTmp, { signal }, tools);
        verified = a === b;
        if (!verified) ctx.log("FLAC verification failed: keeping the original");
      }
      const flacIndex = await flacSeekIndex(flacTmp, probe.sampleRate, tools, signal);
      await ctx.output(ref("flac"), flacTmp, {
        codec: "flac",
        sampleRate: probe.sampleRate,
        channels: dualMono ? 1 : probe.channels,
        bitDepth,
        durationSamples: probe.durationSamples,
        nearLossless: !verifiable,
        verified,
      });
      await ctx.output(ref("seekindex_flac"), await writeJson(ctx, "seek-flac.json", flacIndex), {
        for: "flac",
        entries: flacIndex.length,
      });
      variants.push("flac", "seekindex_flac");
      bestSource = await ctx.input(ref("flac"));

      // Float: the exact copy is a WavPack with every channel (the FLAC above is 24-bit).
      if (isWavPackCandidate(probe)) {
        const wvTmp = path.join(ctx.tmpDir, "audio.wv");
        await encodeWavPack(src, wvTmp, { signal }, tools);
        const a = await audioMd5(src, { float: true, signal }, tools);
        const b = await audioMd5(wvTmp, { float: true, signal }, tools);
        if (a === b) {
          await ctx.output(ref("wavpack"), wvTmp, {
            codec: "wavpack",
            sampleRate: probe.sampleRate,
            channels: probe.channels,
            bitDepth: 32,
            float: true,
            durationSamples: probe.durationSamples,
            verified: true,
          });
          variants.push("wavpack");
          verified = true;
        } else {
          ctx.log("WavPack verification failed: keeping the original");
        }
        ctx.progress(0.35, "wavpack");
      }

      // Dropped only after the whole job succeeds, so a retry after a later failure still has it.
      if (verified && !getSetting(db, "keepOriginalLossless")) originalKept = false;
    }
    ctx.progress(0.4, "lossless done");

    // 5–7: Opus high/low + seek indexes.
    const bitrates = getSetting(db, "audio.opusBitrates");
    const expected = durationSamples48k(probe.durationSamples, probe.sampleRate);
    const mono = playbackChannels === 1;
    // One bitrate per preset for every track (SPEC §5.3 step 5, §28.2); opus_low is fixed.
    const high = opusKbpsFor(db, options.quality, mono);
    const low = mono ? bitrates.lowMono : bitrates.lowStereo;
    for (const [variant, kbps, share, quality] of [
      ["opus", high, 0.6, options.quality],
      ["opus_low", low, 0.75, null],
    ] as const) {
      const out = path.join(ctx.tmpDir, `${variant}.opus`);
      await encodeOpus(
        bestSource,
        out,
        { bitrateKbps: kbps, channels: playbackChannels, signal },
        tools,
      );
      const info = await readOggOpus(out);
      if (info.totalSamples !== expected) {
        ctx.log(
          `${variant}: decoded length ${info.totalSamples} differs from expected ${expected}`,
        );
      }
      await ctx.output(ref(variant), out, {
        codec: "opus",
        bitrate: kbps,
        sampleRate: 48_000,
        channels: playbackChannels,
        preSkip: info.preSkip,
        durationSamples48k: expected,
        decodedSamples: info.totalSamples,
        ...(quality && { quality }),
      });
      const indexFile = await writeJson(ctx, `seek-${variant}.json`, info.seekIndex);
      await ctx.output(ref(`seekindex_${variant}`), indexFile, {
        for: variant,
        entries: info.seekIndex.length,
      });
      variants.push(variant, `seekindex_${variant}`);
      ctx.progress(share, variant);
    }

    // 8: peaks (channels merged), 9: loudness.
    const peaksOut = path.join(ctx.tmpDir, "peaks.dat");
    const peaks = await computePeaks(
      bestSource,
      peaksOut,
      { sampleRate: probe.sampleRate, channels: dualMono ? 1 : probe.channels, signal },
      tools,
    );
    await ctx.output(ref("peaks"), peaksOut, {
      format: "audiowaveform-dat-v1",
      bits: 8,
      samplesPerPixel: 256,
      sampleRate: probe.sampleRate,
      pixels: peaks.pixels,
      overview: peaks.overview,
    });
    variants.push("peaks");
    ctx.progress(0.9, "peaks");

    const loudness = await measureLoudness(src, tools, signal);
    setAssetProbe(db, assetId, { ...probe, loudness });

    if (lossyOnly) {
      finishLossyOnly(ctx, payload, {
        uploadedBy: asset.uploadedBy,
        quality: options.quality,
        kbps: high,
      });
      ctx.progress(1, "ready");
      return { lossless: probe.lossless, dualMono, originalKept: false, variants, lossyOnly };
    }

    // 10: done. The original's blob stays until GC (24 h); the verified FLAC (or WavPack for float)
    // reconstructs it exactly.
    if (!originalKept) removeVariant(db, assetId, "original");
    setAssetStatus(db, assetId, "ready");
    ctx.progress(1, "ready");
    return { lossless: probe.lossless, dualMono, originalKept, variants };
  },
};

/**
 * Lossy on upload (SPEC §28.2): in one transaction the original goes (usage drops; the blob is a
 * GC candidate), every version of the asset is archived by the uploader with reason "upload",
 * `version.lossless_removed` is logged per version, and the asset is ready. Open pages refresh
 * through `version.lossless_removed` per song.
 */
function finishLossyOnly(
  ctx: JobContext,
  payload: AudioIngestPayload,
  info: { uploadedBy: string | null; quality: AudioQuality; kbps: number },
): void {
  const { db } = ctx;
  const now = Date.now();
  const archived = db.transaction(() => {
    removeVariant(db, payload.assetId, "original", now);
    const rows = archiveVersionsOfAssets(db, [payload.assetId], info.uploadedBy, "upload", now);
    for (const v of rows) {
      recordEvent(db, {
        actorType: "worker",
        actorUserId: info.uploadedBy,
        action: "version.lossless_removed",
        projectId: v.projectId,
        songId: v.songId,
        targetType: "trackVersion",
        targetId: v.versionId,
        details: {
          trackId: v.trackId,
          number: v.number,
          assetId: payload.assetId,
          onUpload: true,
          quality: info.quality,
          kbps: info.kbps,
        },
        ts: now,
      });
    }
    setAssetStatus(db, payload.assetId, "ready");
    return rows;
  });
  const bySong = new Map<string, { projectId: string; versionIds: string[] }>();
  for (const v of archived) {
    const e = bySong.get(v.songId) ?? { projectId: v.projectId, versionIds: [] };
    e.versionIds.push(v.versionId);
    bySong.set(v.songId, e);
  }
  for (const [songId, e] of bySong) {
    ctx.emit({
      type: "version.lossless_removed",
      projectId: e.projectId,
      songId,
      data: { versionIds: e.versionIds },
    });
  }
}
