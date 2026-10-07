import fs from "node:fs/promises";
import type { Readable } from "node:stream";
import { DEFAULT_TOOLS, ffmpegArgs, runTool, type ToolPaths } from "./tools";

export const PEAKS_SAMPLES_PER_PIXEL = 256;
export const OVERVIEW_POINTS = 1024;

/**
 * Waveform peaks computed in Node (decision log "Peaks without audiowaveform"): ffmpeg decodes
 * to 16-bit PCM at the source rate, and each 256-frame block becomes one 8-bit min/max pair over
 * all channels (channels merged). The file uses the audiowaveform `.dat` v1 layout:
 *   int32 version=1, uint32 flags (bit0 = 8-bit), int32 sample rate, int32 samples per pixel,
 *   uint32 length (pairs), then int8 min, int8 max per pair.
 */
export class PeaksAccumulator {
  /** Growable int8 storage (a plain number array took ~30 MB for 3 hours of audio). */
  private pairs = new Int8Array(4096);
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
      const grown = new Int8Array(this.pairs.length * 2);
      grown.set(this.pairs);
      this.pairs = grown;
    }
    this.pairs[this.length++] = this.blockMin >> 8;
    this.pairs[this.length++] = this.blockMax >> 8;
    this.blockMin = 32767;
    this.blockMax = -32768;
    this.inBlock = 0;
  }

  /** Returns [min, max, min, max, …] as int8 values. */
  finish(): Int8Array {
    if (this.inBlock > 0) this.flushBlock();
    return this.pairs.slice(0, this.length);
  }
}

export function encodeDat(
  pairs: Int8Array,
  sampleRate: number,
  spp: number = PEAKS_SAMPLES_PER_PIXEL,
): Buffer {
  const header = Buffer.alloc(20);
  header.writeInt32LE(1, 0);
  header.writeUInt32LE(1, 4); // 8-bit
  header.writeInt32LE(sampleRate, 8);
  header.writeInt32LE(spp, 12);
  header.writeUInt32LE(pairs.length / 2, 16);
  return Buffer.concat([header, Buffer.from(pairs.buffer, pairs.byteOffset, pairs.byteLength)]);
}

export function decodeDat(buf: Buffer): { sampleRate: number; spp: number; pairs: Int8Array } {
  if (buf.readInt32LE(0) !== 1 || (buf.readUInt32LE(4) & 1) !== 1)
    throw new Error("Unsupported .dat file");
  const length = buf.readUInt32LE(16);
  return {
    sampleRate: buf.readInt32LE(8),
    spp: buf.readInt32LE(12),
    pairs: new Int8Array(buf.buffer, buf.byteOffset + 20, length * 2),
  };
}

/** 1024-point overview (0–127) for list thumbnails, stored in the peaks variant's meta. */
export function overviewFromPairs(pairs: Int8Array, points: number = OVERVIEW_POINTS): number[] {
  const n = pairs.length / 2;
  const out = new Array<number>(points).fill(0);
  if (n === 0) return out;
  for (let i = 0; i < n; i++) {
    const amp = Math.max(Math.abs(pairs[2 * i] ?? 0), Math.abs(pairs[2 * i + 1] ?? 0));
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
    ffmpegArgs("-i", file, "-map", "0:a:0", "-f", "s16le", "-acodec", "pcm_s16le", "-"),
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
