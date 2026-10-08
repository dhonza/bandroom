import fs from "node:fs/promises";
import path from "node:path";
import { dbToGain, PracticeSchema } from "@bandroom/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getUserById } from "../auth/users";
import type { Db } from "../db/connection";
import { assets } from "../db/schema";
import { recordEvent } from "../events/record";
import { PermanentJobError, type JobHandler } from "../jobs/types";
import { assetProbe, getAsset, setAssetStatus } from "./assets";
import { BounceClickSchema, writeClickWav, type BounceClick } from "./clickTrack";
import { enqueueAudioIngest } from "./ingestJobs";
import { mixChannels, mixGain, panLaw, renderMix, type MixInput } from "./mixGraph";
import type { Probe } from "./probe";
import { quotaCheck } from "./quota";
import {
  BounceStretchSchema,
  needsStretch,
  stretchInputToWav,
  stretchSemitones,
} from "./stretchInput";
import { mediaTimeLimitMs, withTimeLimit } from "./tools";
import { getVariant } from "./variants";

/** One track of a bounce, as the API resolved it from the request (SPEC §5.5). */
export const BounceInputSchema = z.object({
  trackId: z.string(),
  versionId: z.string(),
  assetId: z.string(),
  /** Personal fader in dB. */
  faderDb: z.number(),
  /** The version's own gain in dB (SPEC §25.6). */
  versionGainDb: z.number(),
  pan: z.number().min(-1).max(1),
  /** The version's timeline offset at 48 kHz. */
  offsetSamples: z.number().int().min(0),
  /** How the track follows the practice setting (SPEC §30.7); absent in older payloads. */
  stretch: BounceStretchSchema.optional(),
});
export type BounceInput = z.infer<typeof BounceInputSchema>;

export const BouncePayloadSchema = z
  .object({
    /** The new version's asset: the render becomes its `original`. */
    assetId: z.string(),
    projectId: z.string(),
    /** The new song (SSE fan-out and the following ingest). */
    songId: z.string(),
    trackVersionId: z.string(),
    sourceSongId: z.string(),
    /** Who bounced: the asset counts toward their quota. */
    userId: z.string(),
    inputs: z.array(BounceInputSchema),
    /** The click track, when the bounce includes it (SPEC §5.5). */
    click: BounceClickSchema.optional(),
    /**
     * The practice setting the bounce applies (SPEC §30.7), never neutral; absent = none (and in
     * payloads queued before M24). The click above is already on the scaled tempo map.
     */
    practice: PracticeSchema.optional(),
  })
  .refine((p) => p.inputs.length > 0 || p.click !== undefined, { message: "Nothing to render" });
export type BouncePayload = z.infer<typeof BouncePayloadSchema>;

/**
 * Stable error codes of a failed bounce, stored as the start of the asset's error (SPEC §5.5):
 * a source file is gone, or the render does not fit into the user's quota.
 */
export const BOUNCE_SOURCE_MISSING = "BOUNCE_SOURCE_MISSING";
export const BOUNCE_QUOTA_EXCEEDED = "QUOTA_EXCEEDED";

/** Full quality when there is any; Opus for versions whose full quality was removed (§26.4). */
export const BOUNCE_SOURCE_VARIANTS = ["flac", "original", "opus"] as const;

/**
 * The ffmpeg input of one bounced track (SPEC §5.5), like the engine plays it (SPEC §6.6):
 * gain = fader × version gain, the personal pan with the source's pan law (dual-mono like
 * stereo), delayed by the version's offset; the channels of the file actually read.
 */
export function bounceMixInput(
  input: Pick<BounceInput, "faderDb" | "versionGainDb" | "pan" | "offsetSamples">,
  source: { path: string; variant: string; probe: Pick<Probe, "channels" | "dualMono"> | null },
): MixInput {
  return {
    path: source.path,
    gain: mixGain(input.faderDb, input.versionGainDb),
    pan: input.pan,
    channels: mixChannels(source.probe, source.variant),
    law: panLaw(source.probe),
    offsetSamples: input.offsetSamples,
  };
}

/**
 * The mix input of a bounced click (SPEC §5.5): the click WAV centred at the click volume. A mono
 * file read with the balance law at pan 0 feeds both sides at unity, like the engine's click
 * voices.
 */
export function bounceClickInput(file: string, click: Pick<BounceClick, "gainDb">): MixInput {
  return {
    path: file,
    gain: dbToGain(click.gainDb),
    pan: 0,
    channels: 1,
    law: "stereo",
    offsetSamples: 0,
  };
}

function setOriginalInfo(db: Db, assetId: string, sizeBytes: number, hash: string): void {
  db.update(assets).set({ sizeBytes, originalHash: hash }).where(eq(assets.id, assetId)).run();
}

export type BounceResult =
  | { status: "rendered"; inputs: number; limited: boolean; bytes: number }
  | { status: "ingest"; reason: string };

/**
 * `audio.bounce` (SPEC §5.5): renders the bounced mix in one streaming ffmpeg pass (one job at a
 * time, the files are read from storage, nothing is held in memory), checks the user's quota with
 * the real size, stores the 24-bit WAV as the asset's `original` and queues the normal
 * `audio.ingest`, which makes FLAC, Opus, peaks and loudness like for an upload.
 */
export const audioBounceHandler: JobHandler<BouncePayload, BounceResult> = {
  type: "audio.bounce",
  capability: "audio.bounce",
  payloadSchema: BouncePayloadSchema,
  async run(ctx, payload) {
    const { db, tools } = ctx;
    const asset = getAsset(db, payload.assetId);
    if (!asset) throw new PermanentJobError(`Asset ${payload.assetId} not found`);
    const ingest = () => {
      setAssetStatus(db, asset.id, "queued");
      enqueueAudioIngest(db, {
        assetId: asset.id,
        projectId: payload.projectId,
        songId: payload.songId,
        trackVersionId: payload.trackVersionId,
        createdBy: payload.userId,
      });
    };
    // Rendered before (the job was interrupted after storing it): only the ingest is missing.
    if (getVariant(db, asset.id, "original") || getVariant(db, asset.id, "flac")) {
      ingest();
      return { status: "ingest", reason: "already rendered" };
    }
    setAssetStatus(db, asset.id, "processing");

    const { practice } = payload;
    const rate = practice?.rate ?? 1;
    const sources: { input: BounceInput; path: string; variant: string; probe: Probe | null }[] =
      [];
    // The output length (SPEC §30.7: the time limit follows the stretched length).
    let lengthSec = 0;
    for (const input of payload.inputs) {
      const source = getAsset(db, input.assetId);
      const variant = source && BOUNCE_SOURCE_VARIANTS.find((v) => getVariant(db, source.id, v));
      if (!source || !variant) {
        throw new PermanentJobError(
          `${BOUNCE_SOURCE_MISSING}: the file of version ${input.versionId} is gone`,
        );
      }
      const probe = assetProbe(source);
      const sec = (probe?.durationSec ?? 0) + input.offsetSamples / 48_000;
      lengthSec = Math.max(lengthSec, sec / rate);
      const file = await ctx.input({ assetId: source.id, variant });
      sources.push({ input, path: file, variant, probe });
    }
    if (payload.click) lengthSec = Math.max(lengthSec, payload.click.lengthFrames / 48_000);
    const signal = withTimeLimit(ctx.signal, mediaTimeLimitMs(lengthSec));

    // Stage 1 (SPEC §30.7): every input that changes goes through the stretcher into a float
    // WAV on the output timeline, one at a time; the others are mixed from their source.
    const inputs: MixInput[] = [];
    const stretching = sources.filter((s) => needsStretch(practice, s.input.stretch)).length;
    let stretched = 0;
    for (const [i, s] of sources.entries()) {
      const mix = bounceMixInput(s.input, s);
      if (!needsStretch(practice, s.input.stretch)) {
        inputs.push(mix);
        continue;
      }
      ctx.progress(0.05 + (0.45 * stretched) / stretching, "stretch");
      const file = path.join(ctx.tmpDir, `stretch-${i}.wav`);
      const stretch = s.input.stretch;
      await stretchInputToWav(
        { tools, signal },
        { path: s.path, channels: mix.channels, offsetSamples: s.input.offsetSamples },
        {
          rate: practice.rate,
          semitones: stretchSemitones(practice, stretch),
          profile: stretch?.profile ?? "tonal",
          voiceBaseHz: stretch?.voiceBaseHz ?? 0,
        },
        file,
      );
      stretched++;
      inputs.push({ ...mix, path: file, offsetSamples: 0 });
    }
    if (payload.click) {
      const file = path.join(ctx.tmpDir, "click.wav");
      await writeClickWav(file, payload.click);
      inputs.push(bounceClickInput(file, payload.click));
    }
    ctx.progress(0.5, "render");
    const rendered = await renderMix(
      { tools, tmpDir: ctx.tmpDir, signal, codec: "pcm_s24le" },
      inputs,
    );
    ctx.progress(0.8, "rendered");

    // The final size against the quota, as an upload's finish does (SPEC §15.1).
    const { size } = await fs.stat(rendered.path);
    const user = getUserById(db, payload.userId);
    const quota = user ? quotaCheck(db, user, size) : { ok: true as const };
    if (!quota.ok) {
      throw new PermanentJobError(
        `${BOUNCE_QUOTA_EXCEEDED}: the bounce needs ${size} bytes, ${quota.remainingBytes} left`,
      );
    }

    const hash = await ctx.output({ assetId: asset.id, variant: "original" }, rendered.path, {
      size,
    });
    setOriginalInfo(db, asset.id, size, hash);
    recordEvent(db, {
      actorType: "worker",
      action: "version.rendered",
      projectId: payload.projectId,
      songId: payload.songId,
      targetType: "trackVersion",
      targetId: payload.trackVersionId,
      details: {
        assetId: asset.id,
        sourceSongId: payload.sourceSongId,
        userId: payload.userId,
        inputs: inputs.length,
        click: payload.click !== undefined,
        ...(practice && { practice, stretched }),
        limited: rendered.limited,
        bytes: size,
      },
    });
    ingest();
    ctx.progress(1, "rendered");
    return { status: "rendered", inputs: inputs.length, limited: rendered.limited, bytes: size };
  },
};
