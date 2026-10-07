import fs from "node:fs/promises";
import {
  clickFrames,
  clickSampleLevel,
  clickSamples,
  compileTempo,
  TempoMapSchema,
} from "@bandroom/shared";
import { z } from "zod";

/**
 * The click of a bounce (SPEC §5.5, §6.7): the same pulse frames (`clickFrames`) and the same
 * samples (`synthClick`) as the browser engine, written as a mono 32-bit float WAV at 48 kHz that
 * the mix reads as one more input (gain = the click volume, centred). Written in blocks, so memory
 * stays bounded for any song length.
 */

export const BounceClickSchema = z.object({
  /** The click volume (`click.gainDb`), applied as the input's gain. */
  gainDb: z.number().min(-60).max(6),
  sound: z.enum(["woodblock", "beep", "hihat"]),
  subdivision: z.union([z.literal(1), z.literal(2), z.literal(4)]),
  accent: z.boolean(),
  compoundEighths: z.boolean(),
  /** The source song's tempo map when the bounce was asked for. */
  tempo: z.object({ map: TempoMapSchema, bar1OffsetSec: z.number() }),
  /** Length of the click track: the song's length in the Player (48 kHz frames). */
  lengthFrames: z.number().int().min(0),
});
export type BounceClick = z.infer<typeof BounceClickSchema>;

/** Frames written per block (~190 kB of float samples). */
const BLOCK = 48_000;
const HEADER_BYTES = 44;

/** RIFF header of a mono 32-bit float WAV at 48 kHz with `frames` samples. */
export function floatWavHeader(frames: number): Buffer {
  const data = frames * 4;
  const h = Buffer.alloc(HEADER_BYTES);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20); // IEEE float
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(48_000, 24);
  h.writeUInt32LE(48_000 * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(32, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data, 40);
  return h;
}

/**
 * Renders the click pulses into `out` (frames `[from, from + out.length)`): each pulse's sample
 * starts at its frame, overlapping pulses add up. `first` is the index of the first pulse that
 * may still sound in this block; returns the index for the next block.
 */
export function renderClickBlock(
  out: Float32Array,
  from: number,
  pulses: { frames: Float64Array; levels: Uint8Array },
  samples: readonly Float32Array[],
  accent: boolean,
  first: number,
): number {
  out.fill(0);
  const to = from + out.length;
  let next = first;
  for (let i = first; i < pulses.frames.length; i++) {
    const f = pulses.frames[i] ?? 0;
    if (f >= to) break;
    const s = samples[clickSampleLevel(pulses.levels[i] ?? 1, accent)] ?? new Float32Array(0);
    const end = f + s.length;
    // A pulse that ends inside this block is done for the next one.
    if (end <= to && i === next) next = i + 1;
    for (let j = Math.max(f, from); j < Math.min(end, to); j++)
      out[j - from] = (out[j - from] ?? 0) + (s[j - f] ?? 0);
  }
  return next;
}

/** Writes the click track of a bounce to `file`; returns the number of pulses. */
export async function writeClickWav(file: string, click: BounceClick): Promise<number> {
  const grid = compileTempo(click.tempo);
  const pulses = clickFrames(grid, click.lengthFrames, {
    subdivision: click.subdivision,
    compoundEighths: click.compoundEighths,
  });
  const samples = clickSamples(click.sound);
  const fh = await fs.open(file, "w");
  try {
    await fh.write(floatWavHeader(click.lengthFrames));
    const block = new Float32Array(BLOCK);
    let first = 0;
    for (let from = 0; from < click.lengthFrames; from += BLOCK) {
      const n = Math.min(BLOCK, click.lengthFrames - from);
      const out = n === BLOCK ? block : block.subarray(0, n);
      first = renderClickBlock(out, from, pulses, samples, click.accent, first);
      await fh.write(new Uint8Array(out.buffer, out.byteOffset, n * 4));
    }
  } finally {
    await fh.close();
  }
  return pulses.frames.length;
}
