import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FLOAT_WAV_HEADER_LENGTH,
  floatWavMaxFrames,
  FloatWavWriter,
  parseFloatWavHeader,
  recoverFloatWav,
} from "./floatWav";

const exec = promisify(execFile);

let tmp = "";
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "br-wav-"));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Planar test signal: a sine per channel with overs beyond ±1. */
function signal(channels: number, frames: number): Float32Array[] {
  return Array.from({ length: channels }, (_, c) =>
    Float32Array.from({ length: frames }, (_, i) => 1.5 * Math.sin((i * (c + 1)) / 20)),
  );
}

/** Writes like the take writer: header, chunks of `chunk` frames, the final header at 0. */
function write(planar: Float32Array[], chunk = 4096): { file: Uint8Array; streamed: Uint8Array } {
  const w = new FloatWavWriter({ channels: planar.length });
  const frames = planar[0]?.length ?? 0;
  const parts = [w.header()];
  for (let off = 0; off < frames; off += chunk) {
    const n = Math.min(chunk, frames - off);
    parts.push(
      w.encode(
        planar.map((p) => p.subarray(off, off + n)),
        n,
      ),
    );
  }
  parts.push(w.finish());
  const streamed = concat(parts);
  const file = streamed.slice();
  file.set(w.finalHeader(), 0);
  expect(w.totalSamples).toBe(frames);
  return { file, streamed };
}

/** Planar channels of the data chunk. */
function samples(file: Uint8Array, channels: number): Float32Array[] {
  const data = file.subarray(FLOAT_WAV_HEADER_LENGTH);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const frames = data.length / (4 * channels);
  return Array.from({ length: channels }, (_, c) =>
    Float32Array.from({ length: frames }, (_, i) => v.getFloat32((i * channels + c) * 4, true)),
  );
}

describe("FloatWavWriter (SPEC §9)", () => {
  it("writes a float WAV with a fact chunk; sizes zero while streaming", () => {
    const planar = signal(2, 10_000);
    const { file, streamed } = write(planar, 1000);
    const v = new DataView(file.buffer);
    expect(file.length).toBe(FLOAT_WAV_HEADER_LENGTH + 10_000 * 8);
    expect(v.getUint32(4, true)).toBe(file.length - 8);
    expect(v.getUint16(20, true)).toBe(3);
    expect(v.getUint32(28, true)).toBe(48_000 * 8);
    expect(v.getUint16(32, true)).toBe(8);
    expect(v.getUint32(46, true)).toBe(10_000);
    expect(v.getUint32(54, true)).toBe(10_000 * 8);
    expect(parseFloatWavHeader(file)).toEqual({ channels: 2, sampleRate: 48_000, frames: 10_000 });
    expect(parseFloatWavHeader(streamed)).toEqual({ channels: 2, sampleRate: 48_000, frames: 0 });
    // Round trip: every sample exact, overs kept.
    expect(samples(file, 2)).toEqual(planar);
  });

  it("rejects files that are not float takes", () => {
    const { file } = write(signal(1, 10));
    const pcm = file.slice();
    new DataView(pcm.buffer).setUint16(20, 1, true);
    expect(parseFloatWavHeader(pcm)).toBeNull();
    expect(parseFloatWavHeader(file.subarray(0, 20))).toBeNull();
    expect(() => recoverFloatWav(pcm, pcm.length)).toThrow();
    expect(() => new FloatWavWriter({ channels: 3 })).toThrow();
  });

  it("caps a take at the 4 GiB RIFF limit", () => {
    // About 186 min stereo and 372 min mono at 48 kHz.
    expect(Math.floor(floatWavMaxFrames(2) / 48_000 / 60)).toBe(186);
    expect(Math.floor(floatWavMaxFrames(1) / 48_000 / 60)).toBe(372);
    expect(FLOAT_WAV_HEADER_LENGTH - 8 + floatWavMaxFrames(2) * 8).toBeLessThanOrEqual(2 ** 32 - 1);
  });

  it("recovers an unfinished file from its length (whole frames only)", () => {
    const planar = signal(2, 5000);
    const { file, streamed } = write(planar);
    // The writer stopped mid-frame: 3 bytes of the next frame made it.
    const cut = streamed.slice(0, FLOAT_WAV_HEADER_LENGTH + 4321 * 8 + 3);
    const r = recoverFloatWav(cut.subarray(0, FLOAT_WAV_HEADER_LENGTH), cut.length);
    expect(r).toMatchObject({ frames: 4321, validLength: FLOAT_WAV_HEADER_LENGTH + 4321 * 8 });
    const fixed = cut.slice(0, r.validLength);
    fixed.set(r.header, 0);
    expect(fixed.subarray(FLOAT_WAV_HEADER_LENGTH)).toEqual(
      file.subarray(FLOAT_WAV_HEADER_LENGTH, r.validLength),
    );
    expect(parseFloatWavHeader(fixed)?.frames).toBe(4321);
    expect(samples(fixed, 2)).toEqual(planar.map((p) => p.subarray(0, 4321)));
    // Only the header: no frames.
    expect(recoverFloatWav(streamed, FLOAT_WAV_HEADER_LENGTH).frames).toBe(0);
  });

  it("decodes in ffmpeg with the same samples", async () => {
    for (const channels of [1, 2]) {
      const planar = signal(channels, 12_345);
      const { file } = write(planar, 4096);
      const p = path.join(tmp, `t${String(channels)}.wav`);
      await fs.writeFile(p, file);
      const { stdout: probe } = await exec(
        process.env.FFPROBE_PATH ?? "ffprobe",
        [
          ...["-v", "error", "-show_entries", "stream=codec_name,channels,sample_rate"],
          ...["-show_entries", "stream=duration_ts", "-of", "json", p],
        ],
        { encoding: "utf8" },
      );
      const stream = (JSON.parse(probe) as { streams: Record<string, unknown>[] }).streams[0];
      expect(stream).toMatchObject({
        codec_name: "pcm_f32le",
        channels,
        sample_rate: "48000",
        duration_ts: 12_345,
      });
      const { stdout } = await exec(
        process.env.FFMPEG_PATH ?? "ffmpeg",
        [
          ...["-hide_banner", "-v", "error", "-xerror"],
          ...["-i", p, "-f", "f32le", "-c:a", "pcm_f32le", "-"],
        ],
        { encoding: "buffer", maxBuffer: 1 << 26 },
      );
      const all = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
      expect(all.length).toBe(12_345 * channels);
      for (let c = 0; c < channels; c++) {
        const ch = Float32Array.from({ length: 12_345 }, (_, i) => all[i * channels + c] ?? 0);
        expect(ch).toEqual(planar[c]);
      }
    }
  });
});
