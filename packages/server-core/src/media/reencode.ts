import fs from "node:fs/promises";
import path from "node:path";
import { AudioQualitySchema, type AudioQuality } from "@bandroom/shared";
import { z } from "zod";
import { applyLosslessRemoval, assetLosslessRemoved, planForAsset } from "../content/lossless";
import type { Db } from "../db/connection";
import { recordEvent } from "../events/record";
import { enqueueJob } from "../jobs/queue";
import { PermanentJobError, type JobHandler } from "../jobs/types";
import { assetProbe, getAsset } from "./assets";
import { encodeOpus } from "./encode";
import { durationSamples48k } from "./ingest";
import { readOggOpus } from "./ogg";
import { opusKbpsFor } from "./opusRates";
import { mediaTimeLimitMs, withTimeLimit } from "./tools";
import { getVariant } from "./variants";

export const AudioReencodePayloadSchema = z.object({
  assetId: z.string(),
  /** For SSE fan-out and the processing view. */
  projectId: z.string().nullable().default(null),
  songId: z.string().nullable().default(null),
  trackVersionId: z.string().nullable().default(null),
  quality: AudioQualitySchema,
  /** Remove the full-quality files once the new Opus is in place (always, for now). */
  removeLossless: z.boolean().default(true),
  /** Who asked: the versions are archived by them. */
  userId: z.string().nullable(),
});
export type AudioReencodePayload = z.infer<typeof AudioReencodePayloadSchema>;

/** Queues `audio.reencode` (SPEC §28.3), one per asset. */
export function enqueueAudioReencode(
  db: Db,
  input: Omit<AudioReencodePayload, "removeLossless"> & { removeLossless?: boolean },
): void {
  enqueueJob(db, {
    type: "audio.reencode",
    capability: "audio.reencode",
    payload: { removeLossless: true, ...input },
    dedupeKey: `reencode:${input.assetId}`,
    createdBy: input.userId,
  });
}

export type AudioReencodeResult =
  | { status: "reencoded"; kbps: number; previousKbps: number | null; archived: number }
  | { skipped: string };

/**
 * `audio.reencode` (SPEC §28.3): a new `opus` variant at the chosen quality from the `flac` (else
 * the `original`), with its seek index; `opus_low` stays. Then, in one transaction, the
 * full-quality files go and every version of the asset is archived (reason "reencode"), with
 * `version.reencoded` and `version.lossless_removed` per version. The asset stays ready: the old
 * Opus plays until the swap.
 */
export const audioReencodeHandler: JobHandler<AudioReencodePayload, AudioReencodeResult> = {
  type: "audio.reencode",
  capability: "audio.reencode",
  payloadSchema: AudioReencodePayloadSchema,
  async run(ctx, payload) {
    const { db, tools } = ctx;
    const { assetId } = payload;
    const asset = getAsset(db, assetId);
    if (!asset) throw new PermanentJobError(`Asset ${assetId} not found`);
    const source =
      getVariant(db, assetId, "flac") ??
      getVariant(db, assetId, "original") ??
      getVariant(db, assetId, "wavpack");
    if (!source) {
      // Removed meanwhile (e.g. "keep current" in a later request): nothing to do.
      if (assetLosslessRemoved(db, assetId)) return { skipped: "full quality already removed" };
      throw new PermanentJobError("No full-quality file to re-encode from");
    }
    const probe = assetProbe(asset);
    if (!probe) throw new PermanentJobError("The asset was never probed");
    const old = getVariant(db, assetId, "opus");
    const oldMeta = old ? (JSON.parse(old.meta) as Record<string, unknown>) : {};
    const channels: 1 | 2 =
      oldMeta.channels === 1 || (oldMeta.channels === undefined && probe.channels === 1) ? 1 : 2;
    const previousKbps = typeof oldMeta.bitrate === "number" ? oldMeta.bitrate : null;
    const kbps = opusKbpsFor(db, payload.quality, channels === 1);
    const signal = withTimeLimit(ctx.signal, mediaTimeLimitMs(probe.durationSec));

    ctx.progress(0.05, "reencode");
    const src = await ctx.input({ assetId, variant: source.variant });
    const out = path.join(ctx.tmpDir, "opus.opus");
    await encodeOpus(src, out, { bitrateKbps: kbps, channels, signal }, tools);
    const info = await readOggOpus(out);
    const expected = durationSamples48k(probe.durationSamples, probe.sampleRate);
    if (info.totalSamples !== expected)
      ctx.log(`opus: decoded length ${info.totalSamples} differs from expected ${expected}`);
    ctx.progress(0.8, "encoded");
    // Swaps the blob; the uploader's usage follows the new size.
    await ctx.output({ assetId, variant: "opus" }, out, {
      codec: "opus",
      bitrate: kbps,
      sampleRate: 48_000,
      channels,
      preSkip: info.preSkip,
      durationSamples48k: expected,
      decodedSamples: info.totalSamples,
      quality: payload.quality,
    });
    const indexFile = path.join(ctx.tmpDir, "seek-opus.json");
    await fs.writeFile(indexFile, JSON.stringify(info.seekIndex));
    await ctx.output({ assetId, variant: "seekindex_opus" }, indexFile, {
      for: "opus",
      entries: info.seekIndex.length,
    });
    ctx.progress(0.9, "swapped");

    const archived = payload.removeLossless
      ? finishReencode(ctx, payload, { kbps, previousKbps, quality: payload.quality })
      : 0;
    ctx.progress(1, "done");
    return { status: "reencoded", kbps, previousKbps, archived };
  },
};

function finishReencode(
  ctx: Parameters<JobHandler["run"]>[0],
  payload: AudioReencodePayload,
  info: { kbps: number; previousKbps: number | null; quality: AudioQuality },
): number {
  const { db } = ctx;
  const now = Date.now();
  const archived = db.transaction(
    () => {
      const plan = planForAsset(db, payload.assetId);
      const rows = applyLosslessRemoval(
        db,
        { ...plan, assetIds: [payload.assetId] },
        payload.userId,
        now,
        "reencode",
      );
      for (const v of rows) {
        const common = {
          actorType: "worker" as const,
          actorUserId: payload.userId,
          projectId: v.projectId,
          songId: v.songId,
          targetType: "trackVersion",
          targetId: v.versionId,
          ts: now,
        };
        recordEvent(db, {
          ...common,
          action: "version.reencoded",
          details: {
            trackId: v.trackId,
            number: v.number,
            assetId: payload.assetId,
            quality: info.quality,
            kbps: info.kbps,
            previousKbps: info.previousKbps,
          },
        });
        recordEvent(db, {
          ...common,
          action: "version.lossless_removed",
          details: {
            trackId: v.trackId,
            number: v.number,
            assetId: payload.assetId,
            reencode: true,
            quality: info.quality,
            kbps: info.kbps,
            ...(v.copy && { copy: true }),
          },
        });
      }
      return rows;
    },
    { behavior: "immediate" },
  );
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
      data: { versionIds: e.versionIds, reencoded: true },
    });
  }
  return archived.length;
}
