import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir } from "../testing/tempDir";
import { renderInputs } from "./render";
import {
  envelopeExpr,
  inputPlan,
  renderChannels,
  renderFilter,
  renderSpan,
  seekStep,
  type RenderClip,
  type RenderInput,
} from "./renderGraph";
import { DEFAULT_TOOLS, ffmpegArgs, runTool } from "./tools";

/**
 * The edit render (SPEC §24.10, §24.17 worker): real ffmpeg. Fades and gain must match the
 * engine's envelope (frame centres, linear or sin/cos) within 0.1 dB; impulses land on the
 * exact frame; the same render twice is the same file.
 */

const tools = DEFAULT_TOOLS;
const tmp = makeTempDir("bandroom-render-");
afterAll(() => {
  tmp.cleanup();
});

/** The engine's envelope (`packages/audio-engine/src/clips.ts`), for comparison. */
function engineEnvelope(c: RenderClip, k: number): number {
  let g = 10 ** (c.gainDb / 20);
  if (k < c.fadeInFrames) {
    const x = (k + 0.5) / c.fadeInFrames;
    g *= c.fadeInShape === "linear" ? x : Math.sin((Math.PI / 2) * x);
  }
  const from = c.lengthFrames - c.fadeOutFrames;
  if (c.fadeOutFrames > 0 && k >= from) {
    const x = (k - from + 0.5) / c.fadeOutFrames;
    g *= c.fadeOutShape === "linear" ? 1 - x : Math.cos((Math.PI / 2) * x);
  }
  return g;
}

const clip = (over: Partial<RenderClip> = {}): RenderClip => ({
  sourceStartFrame: 0,
  startFrame: 0,
  lengthFrames: 48_000,
  gainDb: 0,
  fadeInFrames: 0,
  fadeOutFrames: 0,
  fadeInShape: "equalPower",
  fadeOutShape: "equalPower",
  ...over,
});

async function decode(file: string, channels = 1): Promise<Float32Array> {
  const chunks: Buffer[] = [];
  await runTool(
    tools.ffmpeg,
    ffmpegArgs("-i", file, "-ac", String(channels), "-f", "f32le", "-c:a", "pcm_f32le", "-"),
    {
      stdout: async (out: Readable) => {
        for await (const c of out) chunks.push(c as Buffer);
      },
    },
  );
  const buf = Buffer.concat(chunks);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** A WAV made by an ffmpeg lavfi source. */
async function lavfi(name: string, src: string, codec = "pcm_f32le"): Promise<string> {
  const file = path.join(tmp.dir, name);
  await runTool(tools.ffmpeg, ffmpegArgs("-f", "lavfi", "-i", src, "-c:a", codec, file));
  return file;
}

/** Mono impulses (0.9) at the given source frames, `seconds` long at `rate`. */
async function impulses(name: string, rate: number, frames: number[], seconds: number) {
  const expr = frames.map((f) => `eq(n,${f})*0.9`).join("+");
  return lavfi(name, `aevalsrc='${expr}':s=${rate}:d=${seconds}`);
}

function peakAt(pcm: Float32Array, around: number, window = 400): number {
  let best = -1;
  let at = -1;
  for (let i = Math.max(0, around - window); i < Math.min(pcm.length, around + window); i++) {
    const v = Math.abs(pcm[i] ?? 0);
    if (v > best) {
      best = v;
      at = i;
    }
  }
  return at;
}

let dc: string;
beforeAll(async () => {
  dc = await lavfi("dc.wav", "aevalsrc=0.5:s=48000:d=3");
}, 30_000);

describe("render graph (pure)", () => {
  it("seeks on grid points exact in µs and at 48 kHz", () => {
    expect(seekStep(48_000)).toBe(6);
    expect(seekStep(44_100)).toBe(441);
    expect(seekStep(96_000)).toBe(12);
    const p = inputPlan(clip({ sourceStartFrame: 100_000 }), 44_100);
    expect(p.seekSamples % 441).toBe(0);
    expect(Number.isInteger((p.seekSamples * 48_000) / 44_100)).toBe(true);
    expect(p.trimStart).toBe(100_000 - (p.seekSamples * 48_000) / 44_100);
    expect(p.trimStart).toBeGreaterThanOrEqual(24_000);
    expect(inputPlan(clip({ sourceStartFrame: 100 }), 48_000)).toMatchObject({
      seekSamples: 0,
      trimStart: 100,
    });
  });

  it("builds no envelope for a constant gain, and sums with normalize=0", () => {
    expect(envelopeExpr(clip(), 1)).toBeNull();
    expect(envelopeExpr(clip({ fadeInFrames: 10, fadeInShape: "linear" }), 0.5)).toBe(
      "val(ch)*0.5*if(lt(n,10),(n+0.5)/10,1)",
    );
    const src = { path: "a", sampleRate: 48_000, channels: 1 as const, plainMono: true };
    const g = renderFilter(
      [
        { source: src, clip: clip({ startFrame: 10 }) },
        { source: src, clip: clip({ startFrame: 100, gainDb: -6 }) },
      ],
      { start: 10, length: 48_090, channels: 1, resample: "aresample=48000" },
    );
    expect(g).toContain("amix=inputs=2:normalize=0");
    expect(g).toContain("adelay=delays=90S:all=1");
    expect(renderSpan([clip({ startFrame: 10 }), clip({ startFrame: 100 })])).toEqual({
      start: 10,
      length: 48_090,
    });
  });

  it("is mono only when every clip is true mono", () => {
    const i = (plainMono: boolean, channels: 1 | 2): RenderInput => ({
      source: { path: "x", sampleRate: 48_000, channels, plainMono },
      clip: clip(),
    });
    expect(renderChannels([i(true, 1), i(true, 1)])).toBe(1);
    expect(renderChannels([i(true, 1), i(false, 2)])).toBe(2);
    expect(renderChannels([i(false, 1)])).toBe(2); // dual-mono stays two equal channels
  });
});

describe("render (real ffmpeg)", () => {
  it("applies gain and fades within 0.1 dB of the engine's envelope", async () => {
    const shapes = [
      {
        fadeInFrames: 240,
        fadeOutFrames: 12_000,
        fadeInShape: "equalPower",
        fadeOutShape: "linear",
      },
      {
        fadeInFrames: 12_000,
        fadeOutFrames: 240,
        fadeInShape: "linear",
        fadeOutShape: "equalPower",
      },
    ] as const;
    for (const [n, s] of shapes.entries()) {
      const c = clip({
        ...s,
        sourceStartFrame: 30_000,
        startFrame: 0,
        lengthFrames: 60_000,
        gainDb: -6,
      });
      const file = path.join(tmp.dir, `env-${n}.wav`);
      await renderInputs(
        { tools, tmpDir: tmp.dir },
        [{ source: { path: dc, sampleRate: 48_000, channels: 1, plainMono: true }, clip: c }],
        { start: 0, length: c.lengthFrames, channels: 1, file, codec: "pcm_s24le" },
      );
      const pcm = await decode(file);
      expect(pcm.length).toBe(c.lengthFrames);
      let worst = 0;
      for (let k = 0; k < c.lengthFrames; k++) {
        const want = 0.5 * engineEnvelope(c, k);
        const got = pcm[k] ?? 0;
        if (want < 1e-4) continue; // below the 24-bit grid's relative precision
        worst = Math.max(worst, Math.abs(20 * Math.log10(got / want)));
      }
      expect(worst).toBeLessThan(0.1);
    }
  }, 60_000);

  it("puts clips on the exact frame after split, cut and move, and renders twice the same", async () => {
    const src = await impulses("imp48.wav", 48_000, [24_000, 52_800, 72_000, 120_000], 3);
    const source = { path: src, sampleRate: 48_000, channels: 1 as const, plainMono: true };
    // Split at 1 s, cut [1.2 s, 1.6 s) (the tail moves left by 0.4 s), then move the tail +0.25 s.
    const head = clip({ sourceStartFrame: 0, startFrame: 0, lengthFrames: 48_000 });
    const mid = clip({ sourceStartFrame: 48_000, startFrame: 48_000, lengthFrames: 9_600 });
    const tail = clip({
      sourceStartFrame: 76_800,
      startFrame: 57_600 + 12_000,
      lengthFrames: 67_200,
    });
    const inputs = [head, mid, tail].map((c) => ({ source, clip: c }));
    const span = renderSpan([head, mid, tail]);
    const files = ["a.wav", "b.wav"].map((f) => path.join(tmp.dir, f));
    for (const file of files)
      await renderInputs({ tools, tmpDir: tmp.dir }, inputs, {
        ...span,
        channels: 1,
        file,
        codec: "pcm_s24le",
      });
    const pcm = await decode(files[0] as string);
    expect(pcm.length).toBe(span.length);
    // 24 000 and 52 800 stay; 72 000 was cut; 120 000 → 120 000 − 76 800 + 69 600 = 112 800.
    expect(peakAt(pcm, 24_000)).toBe(24_000);
    expect(peakAt(pcm, 52_800)).toBe(52_800);
    expect(peakAt(pcm, 112_800)).toBe(112_800);
    expect(Math.max(...pcm.subarray(57_600, 100_000).map(Math.abs))).toBeLessThan(1e-6);
    const hash = async (f: string) =>
      createHash("sha256")
        .update(await fs.readFile(f))
        .digest("hex");
    expect(await hash(files[0] as string)).toBe(await hash(files[1] as string));
  }, 60_000);

  it("seeks into 44.1 kHz and Opus sources within a frame", async () => {
    const src = await impulses("imp441.wav", 44_100, [44_100, 132_300], 4);
    const flac = path.join(tmp.dir, "imp441.flac");
    await runTool(tools.ffmpeg, ffmpegArgs("-i", src, "-c:a", "flac", flac));
    // Impulses at 1 s and 3 s; the clip starts at 2.5 s of the source, placed at 0.5 s.
    const c = clip({ sourceStartFrame: 120_000, startFrame: 24_000, lengthFrames: 48_000 });
    const file = path.join(tmp.dir, "rate.wav");
    await renderInputs(
      { tools, tmpDir: tmp.dir },
      [{ source: { path: flac, sampleRate: 44_100, channels: 1, plainMono: true }, clip: c }],
      { start: 24_000, length: 48_000, channels: 1, file, codec: "pcm_s24le" },
    );
    const pcm = await decode(file);
    // 3 s of the source = 144 000 at 48 kHz → 144 000 − 120 000 = 24 000 into the output.
    expect(Math.abs(peakAt(pcm, 24_000) - 24_000)).toBeLessThanOrEqual(1);
  }, 60_000);

  it("mixes more clips than one ffmpeg run takes in groups, sample-exact", async () => {
    const source = { path: dc, sampleRate: 48_000, channels: 1 as const, plainMono: true };
    // 70 clips of 1 000 frames, every 1 500 frames, gain −6 dB: 0.25 inside, 0 in the gaps.
    const clips = Array.from({ length: 70 }, (_, i) =>
      clip({
        sourceStartFrame: i * 10,
        startFrame: 500 + i * 1_500,
        lengthFrames: 1_000,
        gainDb: -6,
      }),
    );
    const span = renderSpan(clips);
    const file = path.join(tmp.dir, "groups.wav");
    await renderInputs(
      { tools, tmpDir: tmp.dir },
      clips.map((c) => ({ source, clip: c })),
      { ...span, channels: 1, file, codec: "pcm_f32le" },
    );
    const pcm = await decode(file);
    expect(pcm.length).toBe(span.length);
    const g = 0.5 * 10 ** (-6 / 20);
    for (const at of [0, 999, 1_000, 1_499, 1_500, 69 * 1_500 + 999])
      expect(pcm[at]).toBeCloseTo(at % 1_500 < 1_000 ? g : 0, 6);
  }, 60_000);
});
