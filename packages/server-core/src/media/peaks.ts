import fs from "node:fs/promises";
import type { Readable } from "node:stream";
import { DEFAULT_TOOLS, ffmpegArgs, runTool, type ToolPaths } from "./tools";

export const PEAKS_SAMPLES_PER_PIXEL = 256;
export const OVERVIEW_POINTS = 1024;
/** Peaks written since 0.8.x; older assets have 8-bit peaks until `audio.peaks` rewrites them. */
export const PEAKS_BITS = 16;

/**
 * Waveform peaks computed in Node (decision log "Peaks without audiowaveform"): ffmpeg decodes
 * to 16-bit PCM at the source rate, and each 256-frame block becomes one 16-bit min/max pair over
 * all channels (channels merged). 16 bits keep quiet takes smooth when the waveform is drawn with
 * a large gain (8 bits left a few levels only). The file uses the audiowaveform `.dat` v1 layout:
 *   int32 version=1, uint32 flags (bit0 = 8-bit, else 16-bit), int32 sample rate,
 *   int32 samples per pixel, uint32 length (pairs), then min, max per pair (int8 or int16 LE).
 */
export class PeaksAccumulator {
  /** Growable int16 storage (a plain number array took ~30 MB for 3 hours of audio). */
  private pairs = new Int16Array(4096);
  private length = 0;
  private blockMin = 32767;
  private blockMax = -32768;
  private inBlock = 0;
  private leftover: Buffer | null = null;

  constructor(
    private readonly channels: number,
    private readonly spp: number = PEAKS_SAMPLES_PER_PIXEL,
  ) {}

  push(chunk: Buffer): void {
    let buf = chunk;
    if (this.leftover) {
      buf = Buffer.concat([this.leftover, chunk]);
      this.leftover = null;
    }
    const frameBytes = 2 * this.channels;
    const usable = buf.length - (buf.length % frameBytes);
    for (let off = 0; off < usable; off += frameBytes) {
      for (let c = 0; c < this.channels; c++) {
        const v = buf.readInt16LE(off + 2 * c);
        if (v < this.blockMin) this.blockMin = v;
        if (v > this.blockMax) this.blockMax = v;
      }
      if (++this.inBlock === this.spp) this.flushBlock();
    }
    if (usable < buf.length) this.leftover = Buffer.from(buf.subarray(usable));
  }

  private flushBlock(): void {
    if (this.length + 2 > this.pairs.length) {
      const grown = new Int16Array(this.pairs.length * 2);
      grown.set(this.pairs);
      this.pairs = grown;
    }
    this.pairs[this.length++] = this.blockMin;
    this.pairs[this.length++] = this.blockMax;
    this.blockMin = 32767;
    this.blockMax = -32768;
    this.inBlock = 0;
  }

  /** Returns [min, max, min, max, …] as int16 values. */
  finish(): Int16Array {
    if (this.inBlock > 0) this.flushBlock();
    return this.pairs.slice(0, this.length);
  }
}

/** A 16-bit `.dat` file of int16 [min, max, …] pairs. */
export function encodeDat(
  pairs: Int16Array,
  sampleRate: number,
  spp: number = PEAKS_SAMPLES_PER_PIXEL,
): Buffer {
  const out = Buffer.alloc(20 + pairs.length * 2);
  out.writeInt32LE(1, 0);
  out.writeUInt32LE(0, 4); // 16-bit
  out.writeInt32LE(sampleRate, 8);
  out.writeInt32LE(spp, 12);
  out.writeUInt32LE(pairs.length / 2, 16);
  for (let i = 0; i < pairs.length; i++) out.writeInt16LE(pairs[i] ?? 0, 20 + 2 * i);
  return out;
}

/** Reads an 8- or 16-bit `.dat` file; `pairs` are int16 either way (8-bit values × 256). */
export function decodeDat(buf: Buffer): {
  sampleRate: number;
  spp: number;
  bits: 8 | 16;
  pairs: Int16Array;
} {
  if (buf.readInt32LE(0) !== 1) throw new Error("Unsupported .dat file");
  const bits = (buf.readUInt32LE(4) & 1) === 1 ? 8 : 16;
  const length = buf.readUInt32LE(16);
  const pairs = new Int16Array(length * 2);
  for (let i = 0; i < pairs.length; i++)
    pairs[i] = bits === 8 ? buf.readInt8(20 + i) * 256 : buf.readInt16LE(20 + 2 * i);
  return { sampleRate: buf.readInt32LE(8), spp: buf.readInt32LE(12), bits, pairs };
}

/** 1024-point overview (0–127) for list thumbnails, stored in the peaks variant's meta. */
export function overviewFromPairs(pairs: Int16Array, points: number = OVERVIEW_POINTS): number[] {
  const n = pairs.length / 2;
  const out = new Array<number>(points).fill(0);
  if (n === 0) return out;
  for (let i = 0; i < n; i++) {
    const amp = Math.max(Math.abs(pairs[2 * i] ?? 0), Math.abs(pairs[2 * i + 1] ?? 0)) >> 8;
    const bucket = Math.min(points - 1, Math.floor((i * points) / n));
    if (amp > (out[bucket] ?? 0)) out[bucket] = Math.min(127, amp);
  }
  return out;
}

export async function computePeaks(
  file: string,
  out: string,
  opts: { sampleRate: number; channels: number; signal?: AbortSignal },
  tools: ToolPaths = DEFAULT_TOOLS,
): Promise<{ pixels: number; overview: number[] }> {
  const acc = new PeaksAccumulator(opts.channels);
  await runTool(
    tools.ffmpeg,
    // -ac/-ar pin the PCM to what the accumulator and the file header expect (a dual-mono source
    // folds to one channel; an Opus source decodes at the asset's own rate).
    ffmpegArgs(
      "-i",
      file,
      "-map",
      "0:a:0",
      "-ac",
      String(opts.channels),
      "-ar",
      String(opts.sampleRate),
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-",
    ),
    {
      signal: opts.signal,
      stdout: async (stream: Readable) => {
        for await (const chunk of stream) acc.push(chunk as Buffer);
      },
    },
  );
  const pairs = acc.finish();
  await fs.writeFile(out, encodeDat(pairs, opts.sampleRate));
  return { pixels: pairs.length / 2, overview: overviewFromPairs(pairs) };
}
