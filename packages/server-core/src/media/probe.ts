import { z } from "zod";
import { DEFAULT_TOOLS, runTool, type ToolPaths } from "./tools";

const StreamSchema = z.object({
  index: z.number(),
  codec_type: z.string(),
  codec_name: z.string().optional(),
  sample_rate: z.string().optional(),
  channels: z.number().optional(),
  channel_layout: z.string().optional(),
  sample_fmt: z.string().optional(),
  bits_per_raw_sample: z.string().optional(),
  bits_per_sample: z.number().optional(),
  duration_ts: z.number().optional(),
  duration: z.string().optional(),
  time_base: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

const FfprobeSchema = z.object({
  streams: z.array(StreamSchema).default([]),
  format: z
    .object({
      format_name: z.string().optional(),
      duration: z.string().optional(),
      tags: z.record(z.string(), z.string()).optional(),
    })
    .default({}),
});

const LOSSLESS_CODECS = /^(pcm_|flac$|alac$|wavpack$|ape$|tta$|mlp$|truehd$)/;

export const ProbeSchema = z.object({
  container: z.string(),
  codec: z.string(),
  lossless: z.boolean(),
  sampleRate: z.number(),
  channels: z.number(),
  sampleFormat: z.string(),
  /** Bit depth for PCM/lossless sources (0 when unknown/irrelevant). */
  bitDepth: z.number(),
  isFloat: z.boolean(),
  durationSamples: z.number(),
  durationSec: z.number(),
  tags: z.record(z.string(), z.string()),
  /** BWF bext TimeReference (samples since midnight), if present. */
  timeReference: z.number().nullable(),
  dualMono: z.boolean().optional(),
  loudness: z
    .object({
      integratedLufs: z.number().nullable(),
      lra: z.number().nullable(),
      truePeakDbtp: z.number().nullable(),
    })
    .optional(),
});
export type Probe = z.infer<typeof ProbeSchema>;

export class UnsupportedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMediaError";
  }
}

/** Probes an audio file by content (SPEC §5.2, §5.3 step 1). */
export async function probeAudio(
  file: string,
  tools: ToolPaths = DEFAULT_TOOLS,
  signal?: AbortSignal,
): Promise<Probe> {
  let out: string;
  try {
    ({ stdout: out } = await runTool(
      tools.ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { captureStdout: true, signal, nice: false },
    ));
  } catch {
    throw new UnsupportedMediaError("Not a readable media file");
  }
  const parsed = FfprobeSchema.parse(JSON.parse(out));
  const a = parsed.streams.find((s) => s.codec_type === "audio");
  if (!a?.codec_name || !a.sample_rate || !a.channels)
    throw new UnsupportedMediaError("No audio stream found");

  const sampleRate = Number(a.sample_rate);
  const codec = a.codec_name;
  const lossless = LOSSLESS_CODECS.test(codec);
  const isFloat =
    /^pcm_f(32|64)/.test(codec) ||
    (codec === "flac" ? false : /flt|dbl/.test(a.sample_fmt ?? "") && lossless);
  const bitDepth = Number(a.bits_per_raw_sample ?? 0) || a.bits_per_sample || 0;

  // duration_ts is exact when the stream time base is 1/sampleRate (WAV, FLAC, AIFF, …).
  let durationSamples: number;
  if (a.duration_ts !== undefined && a.time_base === `1/${sampleRate}`) {
    durationSamples = a.duration_ts;
  } else {
    const sec = Number(a.duration ?? parsed.format.duration ?? 0);
    durationSamples = Math.round(sec * sampleRate);
  }
  if (!(durationSamples > 0)) throw new UnsupportedMediaError("Audio has no duration");

  const tags = { ...(parsed.format.tags ?? {}), ...(a.tags ?? {}) };
  const tr = tags.time_reference ?? tags.TIME_REFERENCE;
  return {
    container: parsed.format.format_name ?? "unknown",
    codec,
    lossless,
    sampleRate,
    channels: a.channels,
    sampleFormat: a.sample_fmt ?? "",
    bitDepth,
    isFloat,
    durationSamples,
    durationSec: durationSamples / sampleRate,
    tags,
    timeReference: tr !== undefined && /^\d+$/.test(tr) ? Number(tr) : null,
  };
}
