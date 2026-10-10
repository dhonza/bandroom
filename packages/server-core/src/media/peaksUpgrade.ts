import path from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/connection";
import { assets, assetVariants } from "../db/schema";
import { enqueueJob } from "../jobs/queue";
import { PermanentJobError, type JobHandler } from "../jobs/types";
import { assetProbe, getAsset } from "./assets";
import { computePeaks, PEAKS_BITS, PEAKS_SAMPLES_PER_PIXEL } from "./peaks";
import { mediaTimeLimitMs, withTimeLimit } from "./tools";
import { getVariant } from "./variants";

export const AudioPeaksPayloadSchema = z.object({ assetId: z.string() });
export type AudioPeaksPayload = z.infer<typeof AudioPeaksPayloadSchema>;

/** The sources to decode, best first (lossy-only assets have only their Opus left). */
const SOURCES = ["flac", "original", "wavpack", "opus"];

/** Ready audio assets whose peaks are older than 16-bit and have no failed rewrite. */
export function assetsWithOldPeaks(db: Db): string[] {
  return db
    .select({ id: assets.id })
    .from(assetVariants)
    .innerJoin(assets, eq(assets.id, assetVariants.assetId))
    .where(
      and(
        eq(assetVariants.variant, "peaks"),
        eq(assets.status, "ready"),
        isNull(assets.deletedAt),
        sql`coalesce(json_extract(${assetVariants.meta}, '$.bits'), 8) <> ${PEAKS_BITS}`,
        sql`not exists (select 1 from jobs j where j.dedupe_key = 'peaks:' || ${assets.id}
              and j.status = 'failed')`,
      ),
    )
    .all()
    .map((r) => r.id);
}

/**
 * One-time backfill: rewrites 8-bit peaks as 16-bit (a quiet take drawn with a large gain was
 * blocky). Runs at server start; idempotent (dedupe key, and the job marks the peaks 16-bit).
 * Lowest priority, below interactive uploads and document previews.
 */
export function enqueuePeaksBackfill(db: Db): number {
  const todo = assetsWithOldPeaks(db);
  for (const assetId of todo) {
    enqueueJob(db, {
      type: "audio.peaks",
      capability: "audio.peaks",
      payload: { assetId },
      dedupeKey: `peaks:${assetId}`,
      priority: -10,
      createdBy: null,
    });
  }
  return todo.length;
}

export type AudioPeaksResult = { status: "rewritten"; source: string } | { skipped: string };

/** `audio.peaks`: new peaks from the asset's best audio file; the blob swap is all that changes. */
export const audioPeaksHandler: JobHandler<AudioPeaksPayload, AudioPeaksResult> = {
  type: "audio.peaks",
  capability: "audio.peaks",
  payloadSchema: AudioPeaksPayloadSchema,
  async run(ctx, { assetId }) {
    const { db, tools } = ctx;
    const asset = getAsset(db, assetId);
    if (!asset || asset.deletedAt !== null) return { skipped: "asset gone" };
    const old = getVariant(db, assetId, "peaks");
    if (!old) return { skipped: "no peaks" };
    const oldMeta = JSON.parse(old.meta) as Record<string, unknown>;
    if (oldMeta.bits === PEAKS_BITS) return { skipped: "already 16-bit" };
    const probe = assetProbe(asset);
    if (!probe) throw new PermanentJobError("The asset was never probed");
    const source = SOURCES.find((v) => getVariant(db, assetId, v));
    if (!source) throw new PermanentJobError("No audio file to read the peaks from");

    const signal = withTimeLimit(ctx.signal, mediaTimeLimitMs(probe.durationSec));
    const src = await ctx.input({ assetId, variant: source });
    const out = path.join(ctx.tmpDir, "peaks.dat");
    const peaks = await computePeaks(
      src,
      out,
      { sampleRate: probe.sampleRate, channels: probe.dualMono ? 1 : probe.channels, signal },
      tools,
    );
    await ctx.output({ assetId, variant: "peaks" }, out, {
      ...oldMeta,
      bits: PEAKS_BITS,
      samplesPerPixel: PEAKS_SAMPLES_PER_PIXEL,
      sampleRate: probe.sampleRate,
      pixels: peaks.pixels,
      overview: peaks.overview,
    });
    return { status: "rewritten", source };
  },
};
