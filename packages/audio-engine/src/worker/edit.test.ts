import { statSync } from "node:fs";
import path from "node:path";
import {
  DC_FILE,
  DC_LEFT,
  DC_RIGHT,
  FIXTURES_DIR,
  generateFixtures,
  LONG_OPUS,
  longOpusFixture,
  TONE_FILE,
} from "@bandroom/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LAPS_PER_SEEK } from "../mixer/core";
import { IngestedFixtures } from "../testing/ingested";
import { Rig } from "../testing/rig";
import type { EngineClip, EngineVariant, FadeShape } from "../types";
import { WINDOW_BLOCK, type FileFetcher } from "./bytes";

/**
 * Edit-mode clips in the engine (SPEC §24.5, §24.17): several clips per track with gain, fades,
 * overlaps and mixed layouts, through the real pipeline (ingest, WASM decoders, scheduler, mixer).
 */

let fx: IngestedFixtures;
let dc: string;
let tone: string;
let mono: string;
let stereo: string;

beforeAll(async () => {
  await generateFixtures();
  fx = new IngestedFixtures();
  [dc, tone, mono, stereo] = await Promise.all([
    fx.ingest(DC_FILE()),
    fx.ingest(TONE_FILE()),
    fx.ingest(path.join(FIXTURES_DIR, "imp_48000_s16_mono.wav")),
    fx.ingest(path.join(FIXTURES_DIR, "imp_48000_s24_stereo.wav")),
  ]);
}, 180_000);
afterAll(() => {
  fx.close();
});

const frames = (v: EngineVariant) =>
  v.kind === "opus" ? v.totalFrames : Math.round((v.totalFrames * 48_000) / v.sampleRate);

const clip = (variant: EngineVariant, over: Partial<EngineClip> = {}): EngineClip => ({
  startFrame: 0,
  sourceOffsetFrame: 0,
  lengthFrames: frames(variant) - (over.sourceOffsetFrame ?? 0),
  variant,
  ...over,
});

/** Independent reference of the fade shapes (frame-centred). */
const fadeIn = (shape: FadeShape, k: number, len: number) =>
  shape === "linear" ? (k + 0.5) / len : Math.sin((Math.PI / 2) * ((k + 0.5) / len));
const fadeOut = (shape: FadeShape, k: number, len: number) =>
  shape === "linear" ? 1 - (k + 0.5) / len : Math.cos((Math.PI / 2) * ((k + 0.5) / len));

/** Largest |a − b| over `[from, to)` of a lap and channel of two rigs (or two laps). */
function maxDiff(
  a: Rig,
  lapA: number,
  b: Rig,
  lapB: number,
  from: number,
  to: number,
  ch: "l" | "r" = "l",
): number {
  let max = 0;
  for (let f = from; f < to; f++)
    max = Math.max(max, Math.abs(a.at(lapA, ch, f) - b.at(lapB, ch, f)));
  return max;
}

/** Waits until none of the fetchers has a download running. */
async function idle(fetchers: (FileFetcher | undefined)[]) {
  const deadline = Date.now() + 60_000;
  const busy = () =>
    fetchers.some((f) => (f as unknown as { active: unknown } | undefined)?.active != null);
  while (busy()) {
    if (Date.now() > deadline) throw new Error("downloads did not finish");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function played(clips: EngineClip[][], frames: number): Promise<Rig> {
  const rig = new Rig(fx.fetch);
  rig.load(clips);
  await rig.play(frames);
  expect(rig.underruns).toEqual([]);
  return rig;
}

describe("clip envelopes (SPEC §24.17 engine 1)", () => {
  it.each<[FadeShape, number, FadeShape, number]>([
    ["linear", 240, "equalPower", 12_000],
    ["equalPower", 12_000, "linear", 240],
  ])(
    "fades in (%s, %i) and out (%s, %i) on a constant signal, the cached lap identical",
    { timeout: 120_000 },
    async (inShape, inLen, outShape, outLen) => {
      const v = await fx.variant(dc, "flac");
      const c = clip(v, {
        startFrame: 24_000,
        lengthFrames: 200_000,
        gainDb: -3,
        fadeInFrames: inLen,
        fadeInShape: inShape,
        fadeOutFrames: outLen,
        fadeOutShape: outShape,
      });
      const rig = new Rig(fx.fetch);
      rig.load([[c]]);
      const loop = { start: 10_000, end: 240_000 };
      rig.core.setLoop(loop, LAPS_PER_SEEK, true);
      const B = 2 * LAPS_PER_SEEK;
      rig.seek(loop.start, B);
      await rig.play(3 * (loop.end - loop.start));
      expect(rig.underruns).toEqual([]);
      expect(rig.core.loopCache.complete).toEqual([true]);
      const g = 10 ** (-3 / 20);
      let worst = 0;
      for (let f = loop.start + 240; f < loop.end; f++) {
        const k = f - c.startFrame;
        let want = 0;
        if (k >= 0 && k < c.lengthFrames) {
          want = g;
          if (k < inLen) want *= fadeIn(inShape, k, inLen);
          const o = k - (c.lengthFrames - outLen);
          if (o >= 0) want *= fadeOut(outShape, o, outLen);
        }
        worst = Math.max(
          worst,
          Math.abs(rig.at(B, "l", f) / DC_LEFT - want),
          Math.abs(rig.at(B, "r", f) / DC_RIGHT - want),
        );
      }
      expect(worst).toBeLessThan(1e-6);
      // Repeats from the loop cache are the decoded lap.
      for (const lap of [B + 1, B + 2]) {
        expect(maxDiff(rig, B, rig, lap, loop.start + 240, loop.end), `lap ${lap}`).toBe(0);
      }
      rig.dispose();
    },
  );
});

describe("split equivalence (SPEC §24.17 engine 2)", () => {
  const S = 158_731; // split point, not on any block boundary

  it.each<["flac" | "opus", number]>([
    ["flac", 0],
    ["opus", 1e-3],
  ])("one clip = two contiguous clips (%s)", { timeout: 180_000 }, async (kind, tol) => {
    const v = await fx.variant(tone, kind);
    const one = [[clip(v)]];
    const two = [
      [
        clip(v, { lengthFrames: S }),
        clip(v, { startFrame: S, sourceOffsetFrame: S, lengthFrames: frames(v) - S }),
      ],
    ];
    const total = frames(v);
    // Straight through.
    const a = await played(one, total);
    const b = await played(two, total);
    for (const ch of ["l", "r"] as const) {
      expect(maxDiff(a, 0, b, 0, 0, total, ch), `whole ${ch}`).toBeLessThanOrEqual(tol);
    }
    // A seek into the second clip.
    const at = S + 50_000;
    for (const r of [a, b]) {
      r.seek(at, LAPS_PER_SEEK);
      await r.play(48_000);
    }
    expect(maxDiff(a, LAPS_PER_SEEK, b, LAPS_PER_SEEK, at, at + 48_000)).toBeLessThanOrEqual(tol);
    // A loop ending at the split (its wrap crossfade reads the second clip's start).
    const loop = { start: S - 60_000, end: S };
    const L = 2 * LAPS_PER_SEEK;
    for (const r of [a, b]) {
      r.core.setLoop(loop, LAPS_PER_SEEK, true);
      r.seek(loop.start, L);
      await r.play(3 * 60_000);
      expect(r.underruns).toEqual([]);
    }
    for (const lap of [L, L + 1, L + 2]) {
      expect(maxDiff(a, lap, b, lap, loop.start, loop.end), `lap ${lap}`).toBeLessThanOrEqual(tol);
    }
    a.dispose();
    b.dispose();
  });
});

describe("crossfades, overlaps, moves and layouts (SPEC §24.17 engine 3–6)", () => {
  it(
    "a linear crossfade of contiguous pieces is the plain signal, or a gain ramp",
    { timeout: 120_000 },
    async () => {
      const J = 100_000;
      const F = 4800;
      const pieces = (v: EngineVariant, gA: number, gB: number): EngineClip[] => [
        clip(v, { lengthFrames: J + F / 2, gainDb: gA, fadeOutFrames: F }),
        clip(v, {
          startFrame: J - F / 2,
          sourceOffsetFrame: J - F / 2,
          lengthFrames: frames(v) - (J - F / 2),
          gainDb: gB,
          fadeInFrames: F,
        }),
      ];
      const t = await fx.variant(tone, "flac");
      const plain = await played([[clip(t)]], 200_000);
      const faded = await played([pieces(t, 0, 0)], 200_000);
      expect(maxDiff(plain, 0, faded, 0, 1000, 200_000)).toBeLessThan(1e-6);
      expect(maxDiff(plain, 0, faded, 0, 1000, 200_000, "r")).toBeLessThan(1e-6);
      plain.dispose();
      faded.dispose();
      // Different gains: an exact linear ramp from one to the other over the crossfade.
      const d = await fx.variant(dc, "flac");
      const ramp = await played([pieces(d, -6, 2)], 200_000);
      const gA = 10 ** (-6 / 20);
      const gB = 10 ** (2 / 20);
      let worst = 0;
      for (let f = 1000; f < 200_000; f++) {
        const k = f - (J - F / 2);
        const want = k < 0 ? gA : k >= F ? gB : gA * (1 - (k + 0.5) / F) + gB * ((k + 0.5) / F);
        worst = Math.max(worst, Math.abs(ramp.at(0, "l", f) / DC_LEFT - want));
      }
      expect(worst).toBeLessThan(1e-6);
      ramp.dispose();
    },
  );

  it("sums overlapping clips exactly", { timeout: 120_000 }, async () => {
    const v = await fx.variant(mono, "flac");
    const n = frames(v);
    const plain = await played([[clip(v)]], n);
    const twice = await played([[clip(v), clip(v)]], n);
    const shifted = await played([[clip(v), clip(v, { startFrame: 10_000 })]], n + 10_000);
    for (const t of [24_000, 144_000, 264_000]) {
      const x = plain.at(0, "l", t);
      expect(Math.abs(x)).toBeGreaterThan(0.5);
      expect(twice.at(0, "l", t)).toBe(2 * x);
      expect(shifted.at(0, "l", t)).toBe(x);
      expect(shifted.at(0, "l", t + 10_000)).toBe(x);
    }
    for (const r of [plain, twice, shifted]) r.dispose();
  });

  it.each<["flac" | "opus", number]>([
    ["flac", 0],
    ["opus", 1],
  ])(
    "puts a moved clip's impulse exactly delta frames later (%s)",
    { timeout: 120_000 },
    async (kind, tol) => {
      const v = await fx.variant(mono, kind);
      const delta = 12_345;
      const trim = 5000; // the clip also starts 5000 frames into its source
      const rig = await played(
        [
          [
            clip(v, {
              startFrame: delta,
              sourceOffsetFrame: trim,
              lengthFrames: frames(v) - trim,
            }),
          ],
        ],
        frames(v) + delta,
      );
      for (const t of [24_000, 144_000, 264_000]) {
        const want = t - trim + delta;
        expect(Math.abs(rig.peak(0, "l", want) - want), `${kind} ${t}`).toBeLessThanOrEqual(tol);
      }
      rig.dispose();
    },
  );

  it("plays mono and stereo clips on one track (mono up-mixed)", { timeout: 120_000 }, async () => {
    const m = await fx.variant(mono, "flac");
    const s = await fx.variant(stereo, "flac");
    expect([m.channels, s.channels]).toEqual([1, 2]);
    const split = 100_000;
    const mixed = await played(
      [
        [
          clip(m, { lengthFrames: split }),
          clip(s, { startFrame: split, sourceOffsetFrame: split, lengthFrames: frames(s) - split }),
        ],
      ],
      frames(s),
    );
    const plainMono = await played([[clip(m)]], 48_000);
    const plainStereo = await played([[clip(s)]], frames(s));
    // The mono clip sounds as on a mono track at the centre (−3 dB each side).
    const x = plainMono.at(0, "l", 24_000);
    expect(Math.abs(x)).toBeGreaterThan(0.5);
    expect(mixed.at(0, "l", 24_000)).toBeCloseTo(x, 6);
    expect(mixed.at(0, "r", 24_000)).toBeCloseTo(x, 6);
    // The stereo clip keeps its channels (left 0.9, right 0.45) unchanged.
    for (const ch of ["l", "r"] as const) {
      expect(mixed.at(0, ch, 144_000)).toBe(plainStereo.at(0, ch, 144_000));
      expect(maxDiff(mixed, 0, plainStereo, 0, split, frames(s), ch)).toBe(0);
    }
    expect(mixed.at(0, "r", 144_000)).toBeCloseTo(mixed.at(0, "l", 144_000) / 2, 3);
    for (const r of [mixed, plainMono, plainStereo]) r.dispose();
  });
});

describe("edits while playing (SPEC §24.5)", () => {
  it(
    "switches to a new clip list mid-song, changing the layout",
    { timeout: 120_000 },
    async () => {
      const m = await fx.variant(mono, "flac");
      const s = await fx.variant(stereo, "flac");
      const rig = new Rig(fx.fetch);
      rig.load([[clip(m)]]);
      await rig.play(48_000);
      const split = 100_000;
      rig.sched.setSource(0, 2, [
        clip(m, { lengthFrames: split }),
        clip(s, { startFrame: split, sourceOffsetFrame: split, lengthFrames: frames(s) - split }),
      ]);
      await rig.play(frames(s) - 48_000);
      expect(rig.underruns).toEqual([]);
      const plain = await played([[clip(s)]], frames(s));
      for (const t of [144_000, 264_000]) {
        for (const ch of ["l", "r"] as const) expect(rig.at(0, ch, t)).toBe(plain.at(0, ch, t));
      }
      rig.dispose();
      plain.dispose();
    },
  );

  it("switches a looped track to moved clips, later laps from the new cache", async () => {
    const v = await fx.variant(mono, "flac");
    const rig = new Rig(fx.fetch);
    rig.load([[clip(v)]]);
    const loop = { start: 120_000, end: 170_000 };
    rig.core.setLoop(loop, LAPS_PER_SEEK, true);
    const B = 2 * LAPS_PER_SEEK;
    rig.seek(loop.start, B);
    await rig.play(2 * 50_000);
    rig.sched.setSource(0, 2, [clip(v, { lengthFrames: 50_000 }), clip(v, { startFrame: 10_000 })]);
    await rig.play(4 * 50_000);
    expect(rig.underruns).toEqual([]);
    expect(rig.peak(B, "l", 144_000)).toBe(144_000);
    for (const lap of [B + 3, B + 4, B + 5]) {
      expect(rig.peak(lap, "l", 150_000, 9000), `lap ${lap}`).toBe(154_000);
      expect(rig.at(lap, "l", 144_000)).toBe(0);
    }
    expect(rig.core.loopCache.complete).toEqual([true]);
    rig.dispose();
  });
});

describe("windowed Opus (SPEC §24.5, §24.17)", () => {
  it(
    "plays a 2 h × 8-track session with bounded stored bytes across long seeks",
    { timeout: 300_000 },
    async () => {
      const file = await longOpusFixture();
      const names = Array.from({ length: 8 }, (_, i) => `long${i}`);
      const variants = (await fx.rawOpus(file, names)).map((v) => ({
        ...v,
        fetch: "window" as const,
      }));
      const size = statSync(file).size;
      const keep = 4 * 1024 * 1024;
      const rig = new Rig(fx.fetch, { cacheBytes: 256 * 1024 * 1024, windowKeepBytes: keep });
      rig.load(variants.map((v) => [clip(v)]));
      const files = (rig.sched as unknown as { files: Map<string, { fetcher: FileFetcher }> })
        .files;
      // Repeat period of the fixture: the 60 s piece plus its pre-skip (see `longOpusFixture`).
      const v0 = variants[0];
      const period = ((v0?.totalFrames ?? 0) + (v0?.preSkip ?? 0)) / LONG_OPUS.repeats;
      const impulse = (k: number) => Math.round(k * period) + LONG_OPUS.impulseSecond * 48_000;
      const order = [110, 3, 97, 60, 15, 80, 40, 119, 1, 70, 25, 105];
      let lap = LAPS_PER_SEEK;
      let maxStored = 0;
      for (const k of order) {
        const at = impulse(k) - 24_000;
        rig.record(at, at + 48_000);
        rig.seek(at, lap);
        await rig.play(36_000);
        // Let the 2 MB blocks finish downloading (a real network delivers them; the next seek
        // would otherwise abort them half-way and the test would store less than a device).
        await idle(variants.map((v) => files.get(v.hash)?.fetcher));
        expect(
          Math.abs(rig.peak(lap, "l", impulse(k)) - impulse(k)),
          `piece ${k}`,
        ).toBeLessThanOrEqual(1);
        for (const v of variants) {
          const f = files.get(v.hash)?.fetcher;
          expect(f?.mode).toBe("window");
          maxStored = Math.max(maxStored, f?.file.stored ?? 0);
        }
        lap += LAPS_PER_SEEK;
      }
      expect(rig.errors).toEqual([]);
      expect(rig.underruns).toEqual([]);
      // Never the whole file, and at most the keep limit plus the blocks around the cursor.
      expect(size).toBeGreaterThan(30 * 1024 * 1024);
      expect(maxStored).toBeLessThanOrEqual(keep + 2 * WINDOW_BLOCK);
      const total = variants.reduce((n, v) => n + (files.get(v.hash)?.fetcher.file.stored ?? 0), 0);
      expect(total).toBeLessThanOrEqual(8 * (keep + 2 * WINDOW_BLOCK));
      rig.dispose();
    },
  );
});
