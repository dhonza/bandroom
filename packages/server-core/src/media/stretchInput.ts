import fs from "node:fs/promises";
import type { Readable } from "node:stream";
import { FormantShiftSchema, type Practice } from "@bandroom/shared";
import { createStretch, type StretchModule } from "@bandroom/stretch";
import { loadStretch } from "@bandroom/stretch/node";
import { z } from "zod";
import { floatWavHeader } from "./clickTrack";
import { resampleFilter } from "./encode";
import { ffmpegArgs, runTool, type ToolPaths } from "./tools";
import type {} from "./webassembly";

/**
 * Stage 1 of a practice bounce (SPEC §30.7): one input decoded by ffmpeg to raw float PCM at
 * 48 kHz on a pipe, delayed by its timeline offset, run through the same Signalsmith WASM as the
 * Player (same profile, High quality), and streamed into a 32-bit float WAV that the unchanged mix
 * (stage 2, `renderMix`) reads at offset 0. One ffmpeg at a time, bounded memory: the pipe is read
 * chunk by chunk and every chunk is written before the next one is read.
 */

/** How one bounced track follows the practice setting, resolved from its track record. */
export const BounceStretchSchema = z.object({
  profile: z.enum(["tonal", "voice", "percussive", "mix"]),
  /** The track's effective transpose flag (SPEC §30.3). */
  transpose: z.boolean(),
  /** Formant base for vocals (0 = pitch tracking). */
  voiceBaseHz: z.number().min(0).max(2000),
  /** Formants kept in place (v0.6.1; absent in older payloads = the profile's default). */
  formant: z.boolean().optional(),
  /** Formant shift in semitones (v0.6.1; absent = 0). */
  formantShift: FormantShiftSchema.optional(),
});
export type BounceStretch = z.infer<typeof BounceStretchSchema>;

/** A track without a snapshot (cannot happen for new payloads): transposed, tonal. */
const DEFAULT_STRETCH: BounceStretch = { profile: "tonal", transpose: true, voiceBaseHz: 0 };

/** The pitch shift of one input in semitones (cents as a fraction); 0 when kept at pitch. */
export function stretchSemitones(
  practice: Practice,
  stretch: BounceStretch | undefined = DEFAULT_STRETCH,
): number {
  return stretch.transpose ? practice.semitones + practice.cents / 100 : 0;
}

/**
 * Whether an input goes through stage 1: the speed changes, it is transposed by a non-zero
 * amount, or its formants are shifted. A track kept at pitch at rate 1 is mixed straight from its source (bit-exact).
 */
export function needsStretch(
  practice: Practice | undefined,
  stretch: BounceStretch | undefined,
): practice is Practice {
  return (
    practice !== undefined &&
    (practice.rate !== 1 ||
      stretchSemitones(practice, stretch) !== 0 ||
      (stretch?.formantShift ?? 0) !== 0)
  );
}

/** Output frames of `timelineFrames` played at `rate` (SPEC §30.5: the song length is ⌈L / r⌉). */
export function stretchedFrames(timelineFrames: number, rate: number): number {
  return Math.ceil(timelineFrames / rate);
}

/** Bytes of a stage-1 temp file: float32 at 48 kHz. */
export function stretchTempBytes(outputSec: number, channels: number): number {
  return Math.ceil(outputSec * 48_000) * channels * 4;
}

export interface StretchInputSource {
  path: string;
  /** Channels read from the file (1 for mono and dual-mono, else 2), as the mix reads it. */
  channels: 1 | 2;
  /** Timeline offset at 48 kHz: this many frames of silence come before the file. */
  offsetSamples: number;
}

export interface StretchInputOptions {
  rate: number;
  semitones: number;
  profile: BounceStretch["profile"];
  voiceBaseHz: number;
  /** Formant compensation (default: the profile's) and shift in semitones. */
  formant?: boolean | undefined;
  formantSemitones?: number | undefined;
}

/** Input frames de-interleaved and pushed per stretcher call. */
const BLOCK = 16_384;

/**
 * Stretches one source into the float WAV `out` (see the module comment). The result has
 * ⌈(offsetSamples + source frames) / rate⌉ frames: output frame k is timeline frame k·rate.
 */
export async function stretchInputToWav(
  ctx: { tools: ToolPaths; signal?: AbortSignal; module?: StretchModule },
  source: StretchInputSource,
  opts: StretchInputOptions,
  out: string,
): Promise<{ frames: number; sourceFrames: number }> {
  const mod = ctx.module ?? (await loadStretch());
  const ch = source.channels;
  const stream = createStretch(mod, {
    channels: ch,
    rate: opts.rate,
    semitones: opts.semitones,
    profile: opts.profile,
    quality: "high",
    voiceBaseHz: opts.voiceBaseHz,
    ...(opts.formant !== undefined && { formant: opts.formant }),
    formantSemitones: opts.formantSemitones ?? 0,
    maxIn: BLOCK,
  });
  const planar = Array.from({ length: ch }, () => new Float32Array(BLOCK));
  const fh = await fs.open(out, "w");
  let written = 0;
  let wanted = Infinity;
  const write = async (parts: Float32Array[]) => {
    const n = Math.min(parts[0]?.length ?? 0, wanted - written);
    if (n <= 0) return;
    const buf = Buffer.allocUnsafe(n * ch * 4);
    for (let i = 0; i < n; i++)
      for (let c = 0; c < ch; c++) buf.writeFloatLE(parts[c]?.[i] ?? 0, (i * ch + c) * 4);
    await fh.write(buf);
    written += n;
  };
  /** Pushes `frames` frames already in `planar`. */
  const push = async (frames: number) => {
    ctx.signal?.throwIfAborted();
    await write(stream.push(planar, 0, frames));
  };
  const silence = async (frames: number) => {
    for (const p of planar) p.fill(0);
    for (let left = frames; left > 0; left -= BLOCK) await push(Math.min(BLOCK, left));
  };
  let sourceFrames = 0;
  try {
    await fh.write(floatWavHeader(0, ch)); // sizes are patched at the end
    stream.begin(0);
    await silence(source.offsetSamples);
    const frameBytes = ch * 4;
    let rest = Buffer.alloc(0);
    let fill = 0;
    await runTool(
      ctx.tools.ffmpeg,
      ffmpegArgs(
        "-i",
        source.path,
        "-af",
        await resampleFilter(ctx.tools),
        "-ac",
        String(ch),
        "-ar",
        "48000",
        "-f",
        "f32le",
        "-",
      ),
      {
        signal: ctx.signal,
        stdout: async (s: Readable) => {
          for await (const chunk of s) {
            const data =
              rest.length > 0 ? Buffer.concat([rest, chunk as Buffer]) : (chunk as Buffer);
            const frames = Math.floor(data.length / frameBytes);
            for (let i = 0; i < frames; i++) {
              for (let c = 0; c < ch; c++) {
                const p = planar[c];
                if (p) p[fill] = data.readFloatLE((i * ch + c) * 4);
              }
              if (++fill === BLOCK) {
                await push(fill);
                fill = 0;
              }
            }
            sourceFrames += frames;
            rest = Buffer.from(data.subarray(frames * frameBytes));
          }
        },
      },
    );
    if (fill > 0) await push(fill);
    wanted = stretchedFrames(source.offsetSamples + sourceFrames, opts.rate);
    // Drain the stretcher's latency with silence until the whole output is there.
    for (const p of planar) p.fill(0);
    while (written < wanted) await push(BLOCK);
    const header = floatWavHeader(written, ch);
    await fh.write(header, 0, header.length, 0);
  } finally {
    stream.dispose();
    await fh.close();
  }
  return { frames: written, sourceFrames };
}
