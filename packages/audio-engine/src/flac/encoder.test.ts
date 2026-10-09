import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { FLACDecoder } from "@wasm-audio-decoders/flac";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FlacFrameSplitter } from "../decode/flacFrames";
import {
  FLAC_BLOCK_SIZE,
  FLAC_HEADER_LENGTH,
  FLAC_STREAMINFO_LENGTH,
  FLAC_STREAMINFO_OFFSET,
  FlacEncoder,
  parseStreamInfo,
} from "./encoder";
import { FlacRecovery, recoverFlac } from "./recover";

const exec = promisify(execFile);
const SCALE = 8_388_608;

let tmp = "";
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "br-flac-"));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp24 = (v: number) => Math.max(-SCALE, Math.min(SCALE - 1, Math.round(v)));

/** int24 sample generators: (channel, index) → value. */
type Gen = (c: number, i: number) => number;

function signal(channels: number, frames: number, gen: Gen): Int32Array[] {
  return Array.from({ length: channels }, (_, c) =>
    Int32Array.from({ length: frames }, (_, i) => clamp24(gen(c, i))),
  );
}

const toFloat = (ints: Int32Array[]) => ints.map((ch) => Float32Array.from(ch, (v) => v / SCALE));

/** Encodes in chunks of the given sizes (cycled) and patches STREAMINFO like a take writer. */
function encode(ints: Int32Array[], chunkSizes: number[] = [FLAC_BLOCK_SIZE]): Uint8Array {
  const enc = new FlacEncoder({ channels: ints.length });
  const floats = toFloat(ints);
  const parts: Uint8Array[] = [enc.header()];
  const frames = ints[0]?.length ?? 0;
  let off = 0;
  for (let k = 0; off < frames; k++) {
    const n = Math.min(chunkSizes[k % chunkSizes.length] ?? 1, frames - off);
    parts.push(
      enc.encode(
        floats.map((f) => f.subarray(off, off + n)),
        n,
      ),
    );
    off += n;
  }
  parts.push(enc.finish());
  const file = concat(parts);
  file.set(enc.streamInfo(), FLAC_STREAMINFO_OFFSET);
  return file;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function decodeWasm(file: Uint8Array): Promise<Int32Array[]> {
  const d = new FLACDecoder();
  await d.ready;
  try {
    // Whole frames, as the engine feeds them: the bundled codec-parser drops a final frame of a
    // few bytes (a constant mono block), which libFLAC and ffmpeg decode fine.
    const splitter = new FlacFrameSplitter();
    const frames = [...splitter.push(file.subarray(FLAC_HEADER_LENGTH)), ...splitter.flush()];
    // The splitter syncs with 16 bytes of lookahead: a one-frame stream of a few samples is
    // shorter, and is that one frame.
    if (frames.length === 0) frames.push(file.subarray(FLAC_HEADER_LENGTH));
    const out = await d.decodeFrames(frames);
    expect(out.errors).toEqual([]);
    expect(out.bitDepth).toBe(24);
    expect(out.sampleRate).toBe(48_000);
    // libFLAC (WASM) outputs int / (2^23 − 1) as float32: invertible for every 24-bit value.
    return out.channelData.map((ch) =>
      Int32Array.from(ch.subarray(0, out.samplesDecoded), (v) => Math.round(v * (SCALE - 1))),
    );
  } finally {
    d.free();
  }
}

let fileNo = 0;
async function decodeFfmpeg(file: Uint8Array, channels: number): Promise<Int32Array[]> {
  const p = path.join(tmp, `t${fileNo++}.flac`);
  await fs.writeFile(p, file);
  const { stdout } = await exec(
    process.env.FFMPEG_PATH ?? "ffmpeg",
    [
      ...["-hide_banner", "-v", "error", "-xerror", "-err_detect", "crccheck+bitstream+explode"],
      ...["-i", p, "-f", "s32le", "-c:a", "pcm_s32le", "-"],
    ],
    { encoding: "buffer", maxBuffer: 1 << 28 },
  );
  const all = new Int32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
  return Array.from({ length: channels }, (_, c) =>
    Int32Array.from({ length: all.length / channels }, (_, i) => (all[i * channels + c] ?? 0) >> 8),
  );
}

async function expectRoundTrip(ints: Int32Array[], chunks?: number[]): Promise<Uint8Array> {
  const file = encode(ints, chunks);
  const info = parseStreamInfo(file.subarray(FLAC_STREAMINFO_OFFSET));
  expect(info).toMatchObject({
    channels: ints.length,
    bitsPerSample: 24,
    sampleRate: 48_000,
    totalSamples: ints[0]?.length,
  });
  for (const decoded of [await decodeWasm(file), await decodeFfmpeg(file, ints.length)]) {
    expect(decoded).toHaveLength(ints.length);
    decoded.forEach((ch, c) => {
      expect(ch.length).toBe(ints[c]?.length);
      expect(firstDifference(ch, ints[c] as Int32Array)).toBe(-1);
    });
  }
  return file;
}

function firstDifference(a: Int32Array, b: Int32Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

const MAX = SCALE - 1;
const SECONDS = 48_000;

describe("FlacEncoder (SPEC §9): bit-exact with libFLAC (WASM) and ffmpeg", () => {
  it("silence is tiny (constant subframes)", async () => {
    const file = await expectRoundTrip(signal(2, SECONDS, () => 0));
    expect(file.length).toBeLessThan(FLAC_HEADER_LENGTH + 12 * 30);
  });

  it("full-scale square wave, incl. the clipping of out-of-range floats", async () => {
    await expectRoundTrip(signal(1, SECONDS, (_, i) => (Math.floor(i / 50) % 2 ? MAX : -SCALE)));
    const enc = new FlacEncoder({ channels: 1 });
    const loud = Float32Array.from({ length: 5000 }, (_, i) => (i % 2 ? 1.5 : -3));
    const file = concat([enc.header(), enc.encode([loud]), enc.finish()]);
    file.set(enc.streamInfo(), FLAC_STREAMINFO_OFFSET);
    const [ch] = await decodeWasm(file);
    expect(ch?.slice(0, 4)).toEqual(Int32Array.from([-SCALE, MAX, -SCALE, MAX]));
  });

  it("white noise (escape partitions and verbatim)", async () => {
    const r = rng(1);
    await expectRoundTrip(signal(2, SECONDS, () => (r() * 2 - 1) * SCALE));
    const q = rng(2);
    await expectRoundTrip(signal(1, 20_000, () => (q() * 2 - 1) * 1000));
  });

  it("silence with sparse clicks and loud slow ramps (zero-width escapes, 5-bit parameters)", async () => {
    await expectRoundTrip(
      signal(1, 3 * FLAC_BLOCK_SIZE, (_, i) => (i % 1500 === 7 ? 4_000_000 : 0)),
    );
    const r = rng(8);
    // Large residuals that still beat verbatim: Rice parameters above 14.
    await expectRoundTrip(signal(2, 2 * FLAC_BLOCK_SIZE, () => (r() * 2 - 1) * 2 ** 20 + 2 ** 22));
  });

  it("right/side stereo and higher fixed orders", async () => {
    const r = rng(9);
    let a = 0;
    let b = 0;
    let c = 0;
    // Right/side: the right channel is smooth (it clips: constant blocks), the side small noise.
    const smooth = Int32Array.from({ length: 3 * FLAC_BLOCK_SIZE }, () => {
      a += r() - 0.5;
      b += a;
      c += b;
      return clamp24(c);
    });
    const noisy = smooth.map((v) => clamp24(v + (r() - 0.5) * 5000));
    await expectRoundTrip([noisy, smooth]);
    await expectRoundTrip([smooth]);
    // A loud 50 Hz sine: order 3 predicts it best (order 4 only amplifies the rounding noise).
    await expectRoundTrip(
      signal(1, 2 * FLAC_BLOCK_SIZE, (_, i) => 0.5 * SCALE * Math.sin(i * 0.00654)),
    );
    await expectRoundTrip(signal(1, 4, (_, i) => i * 3));
  });

  it("frame numbers beyond one byte (many frames, small blocks)", async () => {
    const r = rng(10);
    const ints = signal(1, 140 * FLAC_BLOCK_SIZE, () => r() * 200);
    await expectRoundTrip(ints);
    // 16-sample blocks: 4000+ frames need three-byte frame numbers.
    const enc = new FlacEncoder({ channels: 2, blockSize: 16 });
    const x = Float32Array.from({ length: 70_001 }, (_, i) => ((i * 7919) % 2001) / SCALE);
    const file = concat([enc.header(), enc.encode([x, x]), enc.finish()]);
    file.set(enc.streamInfo(), FLAC_STREAMINFO_OFFSET);
    const want = Int32Array.from(x, (v) => Math.round(v * SCALE));
    for (const decoded of [await decodeWasm(file), await decodeFfmpeg(file, 2)])
      expect(firstDifference(decoded[1] as Int32Array, want)).toBe(-1);
    const rec = recoverFlac(file.subarray(0, file.length - 3));
    expect(rec.totalSamples).toBe(70_000);
  });

  it("refuses bad options and inputs", () => {
    expect(() => new FlacEncoder({ channels: 1, blockSize: 8 })).toThrow(/block size/);
    expect(() => new FlacEncoder({ channels: 1, blockSize: 70_000 })).toThrow(/block size/);
    const enc = new FlacEncoder({ channels: 2 });
    expect(() => enc.encode([new Float32Array(4)])).toThrow(/channel count/);
  });

  it("sines compress well", async () => {
    const ints = signal(2, 2 * SECONDS, (c, i) => 0.5 * SCALE * Math.sin((i * (440 + c)) / 7640));
    const file = await expectRoundTrip(ints);
    expect(file.length).toBeLessThan(2 * SECONDS * 2 * 3 * 0.6);
  });

  it("stereo: identical and opposite channels pick side coding", async () => {
    const r = rng(3);
    const base = Int32Array.from({ length: SECONDS }, () => clamp24((r() * 2 - 1) * SCALE * 0.9));
    const same = await expectRoundTrip([base, base.slice()]);
    const opposite = await expectRoundTrip([base, base.map((v) => Math.max(-MAX, -v))]);
    const mono = encode([base]);
    // A constant (or silent) side channel costs next to nothing.
    expect(same.length).toBeLessThan(mono.length * 1.01);
    expect(opposite.length).toBeLessThan(mono.length * 1.05);
  });

  it("odd tail block and streams shorter than one block", async () => {
    const r = rng(4);
    await expectRoundTrip(signal(2, 3 * FLAC_BLOCK_SIZE + 1001, (_, i) => r() * 2000 + i));
    await expectRoundTrip(signal(1, 777, (_, i) => i * 1000));
    await expectRoundTrip(signal(2, 3, (c) => c * 5));
    await expectRoundTrip(signal(1, 1, () => 42));
  });

  it("streams chunks of odd sizes across block boundaries", async () => {
    const r = rng(5);
    let v = 0;
    const ints = signal(2, 5 * FLAC_BLOCK_SIZE + 123, (c) => {
      v += (r() - 0.5) * 20_000; // a random walk: higher fixed orders win
      return c === 0 ? v : v * 0.5;
    });
    const chunked = await expectRoundTrip(ints, [1, 127, 128, 3000, 4097, 4096, 5]);
    expect(chunked).toEqual(encode(ints));
  });

  it("writes unknown totals first and the final STREAMINFO at its offset", () => {
    const enc = new FlacEncoder({ channels: 2 });
    const head = enc.header();
    expect(head).toHaveLength(FLAC_HEADER_LENGTH);
    expect(parseStreamInfo(head.subarray(FLAC_STREAMINFO_OFFSET))).toMatchObject({
      totalSamples: 0,
      minFrameSize: 0,
      maxFrameSize: 0,
      minBlockSize: 4096,
      maxBlockSize: 4096,
    });
    const r = rng(6);
    const chunk = Float32Array.from({ length: 10_000 }, () => r() - 0.5);
    const sizes = [enc.encode([chunk, chunk]).length, enc.finish().length];
    expect(enc.totalSamples).toBe(10_000);
    const info = parseStreamInfo(enc.streamInfo());
    expect(enc.streamInfo()).toHaveLength(FLAC_STREAMINFO_LENGTH);
    expect(info.totalSamples).toBe(10_000);
    expect(info.maxFrameSize).toBeGreaterThan(info.minFrameSize);
    expect(sizes[1]).toBeGreaterThanOrEqual(info.minFrameSize);
    expect(() => enc.encode([chunk, chunk])).toThrow(/finished/);
    expect(() => new FlacEncoder({ channels: 3 })).toThrow();
  });
});

describe("FLAC crash recovery (SPEC §9)", () => {
  it("re-derives STREAMINFO of a truncated take and keeps its complete frames", async () => {
    const r = rng(7);
    const ints = signal(
      2,
      10 * FLAC_BLOCK_SIZE + 500,
      (c, i) => Math.sin(i / 40) * 100_000 + r() * 3000 * (c + 1),
    );
    const full = encode(ints);
    // What a crash leaves: the header with unknown totals and a cut-off last frame.
    const enc = new FlacEncoder({ channels: 2 });
    const unpatched = concat([enc.header(), full.subarray(FLAC_HEADER_LENGTH)]);
    const cut = unpatched.subarray(0, Math.floor(unpatched.length * 0.73));

    // Fed in small chunks, as read from disk.
    const rec = new FlacRecovery();
    for (let o = 0; o < cut.length; o += 777) rec.push(cut.subarray(o, o + 777));
    const result = rec.finish();
    expect(result.frames).toBeGreaterThan(5);
    expect(result.totalSamples).toBe(result.frames * FLAC_BLOCK_SIZE);
    expect(result).toEqual(recoverFlac(cut));

    const fixed = cut.slice(0, result.validLength);
    fixed.set(result.streamInfo, FLAC_STREAMINFO_OFFSET);
    const want = ints.map((ch) => ch.subarray(0, result.totalSamples));
    for (const decoded of [await decodeWasm(fixed), await decodeFfmpeg(fixed, 2)]) {
      decoded.forEach((ch, c) => {
        expect(ch.length).toBe(result.totalSamples);
        expect(firstDifference(ch, want[c] as Int32Array)).toBe(-1);
      });
    }
  });

  it("recovers a complete file as it is, and a header-only file as empty", () => {
    const ints = signal(1, 2 * FLAC_BLOCK_SIZE + 9, (_, i) => (i * 37) % 5000);
    const full = encode(ints);
    const result = recoverFlac(full);
    expect(result.validLength).toBe(full.length);
    expect(result.totalSamples).toBe(2 * FLAC_BLOCK_SIZE + 9);
    expect(result.streamInfo).toEqual(full.subarray(FLAC_STREAMINFO_OFFSET, FLAC_HEADER_LENGTH));

    const empty = recoverFlac(new FlacEncoder({ channels: 1 }).header());
    expect(empty).toMatchObject({ validLength: FLAC_HEADER_LENGTH, frames: 0, totalSamples: 0 });
    expect(() => recoverFlac(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/FLAC/);
    expect(() => recoverFlac(new Uint8Array([0x66]))).toThrow(/header/);
  });
});
