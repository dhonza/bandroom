import { z } from "zod";

// Opus quality presets and upload options (SPEC §28.2).

export const AUDIO_QUALITIES = ["veryHigh", "high", "standard", "low"] as const;
export type AudioQuality = (typeof AUDIO_QUALITIES)[number];
export const AudioQualitySchema = z.enum(AUDIO_QUALITIES);

/** The `opus` variant's bitrate per preset in kbps (stereo / mono); `opus_low` stays 48/32. */
export const AUDIO_QUALITY_KBPS: Record<AudioQuality, { stereo: number; mono: number }> = {
  veryHigh: { stereo: 160, mono: 96 },
  high: { stereo: 128, mono: 80 },
  /** The `audio.opusBitrates` setting's defaults; the server reads the setting. */
  standard: { stereo: 96, mono: 64 },
  low: { stereo: 64, mono: 48 },
};

export const DEFAULT_AUDIO_QUALITY: AudioQuality = "standard";

/** Per-upload choices carried in the tus target and stored on the asset (SPEC §28.2). */
export const UploadOptionsSchema = z.object({
  /** Keep only Opus: the original and the FLAC are dropped after encoding. */
  lossyOnly: z.boolean().default(false),
  quality: AudioQualitySchema.default(DEFAULT_AUDIO_QUALITY),
});
export type UploadOptions = z.infer<typeof UploadOptionsSchema>;

/**
 * The `opus` bitrate of a preset. `standard` is the instance's setting (`audio.opusBitrates`),
 * passed by the server; it defaults to the table.
 */
export function opusKbps(
  quality: AudioQuality,
  mono: boolean,
  standard: { stereo: number; mono: number } = AUDIO_QUALITY_KBPS.standard,
): number {
  const rates = quality === "standard" ? standard : AUDIO_QUALITY_KBPS[quality];
  return mono ? rates.mono : rates.stereo;
}

/** The preset an Opus bitrate belongs to, or `null` for a bitrate no preset uses. */
export function qualityForKbps(
  kbps: number,
  mono: boolean,
  standard: { stereo: number; mono: number } = AUDIO_QUALITY_KBPS.standard,
): AudioQuality | null {
  return AUDIO_QUALITIES.find((q) => opusKbps(q, mono, standard) === kbps) ?? null;
}
