import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { generateFixtures, matrix } from "@bandroom/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir } from "../testing/tempDir";
import { probeAudio } from "./probe";
import {
  needsStretch,
  stretchedFrames,
  stretchInputToWav,
  stretchSemitones,
  stretchTempBytes,
} from "./stretchInput";
import { DEFAULT_TOOLS, ffmpegArgs, runTool } from "./tools";

const SR = 48_000;
let tmp: ReturnType<typeof makeTempDir>;

beforeAll(async () => {
  await generateFixtures();
  tmp = makeTempDir();
}, 60_000);
afterAll(() => {
  tmp.cleanup();
});

const fixture = (name: string) => {
  const f = matrix().find((x) => x.name === name);
  if (!f) throw new Error(`fixture ${name}`);
  return f.file;
};

/** Channel `c` of a float WAV (read back through ffmpeg, as the mix reads it). */
async function decode(file: string, c = 0): Promise<Float32Array> {
  const chunks: Buffer[] = [];
  await runTool(
    DEFAULT_TOOLS.ffmpeg,
    ffmpegArgs("-i", file, "-af", `pan=mono|c0=c${c}`, "-f", "f32le", "-"),
    {
      stdout: async (s: Readable) => {
        for await (const ch of s) chunks.push(ch as Buffer);
      },
    },
  );
  const buf = Buffer.concat(chunks);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function peakAt(x: Float32Array, from: number, to: number): number {
  let best = -1;
  let at = -1;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) {
    const v = Math.abs(x[i] ?? 0);
    if (v > best) {
      best = v;
      at = i;
    }
  }
  return at;
}

/** Frequency from interpolated rising zero crossings. */
function frequency(x: Float32Array, from: number, to: number): number {
  const crossings: number[] = [];
  for (let i = from + 1; i < to; i++) {
    const a = x[i - 1] ?? 0;
    const b = x[i] ?? 0;
    if (a < 0 && b >= 0) crossings.push(i - 1 + a / (a - b));
  }
  const first = crossings[0] ?? 0;
  const last = crossings[crossings.length - 1] ?? 0;
  return ((crossings.length - 1) * SR) / (last - first);
}

describe("stretch helpers (SPEC §30.7)", () => {
  const p = { rate: 1, semitones: -2, cents: 8 };
  it("shifts transposed tracks by semitones and cents, others not at all", () => {
    expect(stretchSemitones(p, { profile: "tonal", transpose: true, voiceBaseHz: 0 })).toBe(-1.92);
    expect(stretchSemitones(p, { profile: "percussive", transpose: false, voiceBaseHz: 0 })).toBe(
      0,
    );
    // An old snapshot without the flags: transposed.
    expect(stretchSemitones(p, undefined)).toBe(-1.92);
  });

  it("skips inputs that would come out unchanged", () => {
    const drums = { profile: "percussive" as const, transpose: false, voiceBaseHz: 0 };
    const keys = { profile: "tonal" as const, transpose: true, voiceBaseHz: 0 };
    expect(needsStretch(undefined, keys)).toBe(false);
    expect(needsStretch(p, drums)).toBe(false);
    expect(needsStretch(p, keys)).toBe(true);
    expect(needsStretch({ ...p, rate: 0.75 }, drums)).toBe(true);
    expect(needsStretch({ rate: 1, semitones: 1, cents: -100 }, keys)).toBe(false);
  });

  it("sizes the output and its temp file", () => {
    expect(stretchedFrames(288_000, 0.75)).toBe(384_000);
    expect(stretchedFrames(10, 0.3)).toBe(34);
    expect(stretchTempBytes(2, 2)).toBe(2 * SR * 2 * 4);
  });
});

describe("stretchInputToWav (SPEC §30.7)", () => {
  it(
    "puts an impulse at t on t / rate, after the offset, with the whole output length",
    { timeout: 180_000 },
    async () => {
      const out = path.join(tmp.dir, "imp.wav");
      const offset = 4_800;
      const rate = 0.75;
      const r = await stretchInputToWav(
        { tools: DEFAULT_TOOLS },
        { path: fixture("imp_48000_s16_mono"), channels: 1, offsetSamples: offset },
        { rate, semitones: 0, profile: "percussive", voiceBaseHz: 0 },
        out,
      );
      expect(r.sourceFrames).toBe(6 * SR);
      expect(r.frames).toBe(Math.ceil((6 * SR + offset) / rate));
      const probe = await probeAudio(out);
      expect(probe.channels).toBe(1);
      expect(probe.sampleRate).toBe(SR);
      const pcm = await decode(out);
      expect(pcm.length).toBe(r.frames);
      for (const sec of [0.5, 3, 5.5]) {
        const want = (sec * SR + offset) / rate;
        expect(Math.abs(peakAt(pcm, want - 4_000, want + 4_000) - want)).toBeLessThanOrEqual(400);
      }
      // The file is streamed: its size is the header and the frames, nothing more.
      expect((await fs.stat(out)).size).toBe(44 + r.frames * 4);
    },
  );

  it(
    "transposes a 1 kHz sine within ±2 cents, in stereo, at the original speed",
    { timeout: 180_000 },
    async () => {
      const sine = path.join(tmp.dir, "sine.wav");
      await runTool(
        DEFAULT_TOOLS.ffmpeg,
        ffmpegArgs(
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=1000:sample_rate=48000:duration=3",
          "-ac",
          "2",
          "-c:a",
          "pcm_s16le",
          sine,
        ),
      );
      const out = path.join(tmp.dir, "sine-shifted.wav");
      const r = await stretchInputToWav(
        { tools: DEFAULT_TOOLS },
        { path: sine, channels: 2, offsetSamples: 0 },
        { rate: 1, semitones: -2, profile: "tonal", voiceBaseHz: 0 },
        out,
      );
      expect(r.frames).toBe(3 * SR);
      for (const c of [0, 1]) {
        const pcm = await decode(out, c);
        const cents = 1200 * Math.log2(frequency(pcm, SR / 2, SR * 2.5) / 1000) + 200;
        expect(Math.abs(cents)).toBeLessThan(2);
      }
    },
  );

  it("stops when the job is aborted", { timeout: 60_000 }, async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      stretchInputToWav(
        { tools: DEFAULT_TOOLS, signal: ctl.signal },
        { path: fixture("imp_48000_s16_mono"), channels: 1, offsetSamples: 0 },
        { rate: 0.5, semitones: 0, profile: "tonal", voiceBaseHz: 0 },
        path.join(tmp.dir, "aborted.wav"),
      ),
    ).rejects.toThrow();
  });
});
