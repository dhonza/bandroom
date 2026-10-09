import { describe, expect, it } from "vitest";
import {
  addClip,
  applyEnvelope,
  clipEnvelope,
  defaultFetch,
  fadeInGain,
  fadeOutGain,
  fetchModeOf,
  trackLayout,
  unityEnvelope,
  upmixGain,
} from "./clips";
import { clipRanges, WINDOWED_OPUS_FRAMES, type EngineClip, type EngineVariant } from "./types";

const variant = (over: Partial<EngineVariant> = {}): EngineVariant => ({
  kind: "opus",
  hash: "h",
  url: "/b/h",
  seekIndexUrl: null,
  channels: 2,
  preSkip: 312,
  totalFrames: 480_000,
  sampleRate: 48_000,
  ...over,
});

const clip = (over: Partial<EngineClip> = {}): EngineClip => ({
  startFrame: 1000,
  sourceOffsetFrame: 0,
  lengthFrames: 10_000,
  variant: variant(),
  ...over,
});

describe("clip envelope (SPEC §24.5)", () => {
  it("is the clip gain inside the clip and 0 outside", () => {
    const c = clip({ gainDb: -6 });
    expect(clipEnvelope(c, 999)).toBe(0);
    expect(clipEnvelope(c, 11_000)).toBe(0);
    expect(clipEnvelope(c, 5000)).toBeCloseTo(10 ** (-6 / 20), 12);
    expect(clipEnvelope(clip(), 1000)).toBe(1);
  });

  it("fades in and out with linear and equal-power shapes at frame centres", () => {
    const lin = clip({ fadeInFrames: 100, fadeOutFrames: 200 });
    expect(clipEnvelope(lin, 1000)).toBeCloseTo(0.5 / 100, 12);
    expect(clipEnvelope(lin, 1099)).toBeCloseTo(99.5 / 100, 12);
    expect(clipEnvelope(lin, 1100)).toBe(1);
    expect(clipEnvelope(lin, 10_800)).toBeCloseTo(1 - 0.5 / 200, 12);
    expect(clipEnvelope(lin, 10_999)).toBeCloseTo(0.5 / 200, 12);
    const eq = clip({
      fadeInFrames: 100,
      fadeOutFrames: 100,
      fadeInShape: "equalPower",
      fadeOutShape: "equalPower",
      gainDb: 6,
    });
    const g = 10 ** (6 / 20);
    expect(clipEnvelope(eq, 1010)).toBeCloseTo(g * Math.sin((Math.PI / 2) * (10.5 / 100)), 12);
    expect(clipEnvelope(eq, 10_910)).toBeCloseTo(g * Math.cos((Math.PI / 2) * (10.5 / 100)), 12);
  });

  it("multiplies overlapping fades on a short clip", () => {
    const c = clip({ lengthFrames: 100, fadeInFrames: 100, fadeOutFrames: 100 });
    expect(clipEnvelope(c, 1050)).toBeCloseTo((50.5 / 100) * (1 - 50.5 / 100), 12);
  });

  it("sums a linear fade-out and fade-in over the same frames to exactly 1", () => {
    for (const len of [1, 7, 240, 12_000]) {
      for (let k = 0; k < len; k += Math.max(1, Math.floor(len / 50))) {
        expect(fadeInGain("linear", k, len) + fadeOutGain("linear", k, len)).toBeCloseTo(1, 15);
        const p = fadeInGain("equalPower", k, len) ** 2 + fadeOutGain("equalPower", k, len) ** 2;
        expect(p).toBeCloseTo(1, 12);
      }
    }
  });

  it("knows where it is unity", () => {
    const c = clip({ fadeInFrames: 100, fadeOutFrames: 100 });
    expect(unityEnvelope(c, 1100, 10_900)).toBe(true);
    expect(unityEnvelope(c, 1099, 2000)).toBe(false);
    expect(unityEnvelope(c, 5000, 10_901)).toBe(false);
    expect(unityEnvelope(clip(), 1000, 11_000)).toBe(true);
    expect(unityEnvelope(clip({ gainDb: 0.1 }), 5000, 5001)).toBe(false);
  });

  it("applies in place and adds with up-mix", () => {
    const c = clip({ fadeInFrames: 4, gainDb: -6 });
    const g = 10 ** (-6 / 20);
    const data = [new Float32Array([1, 1, 1, 1, 1, 1]), new Float32Array(6).fill(2)];
    applyEnvelope(c, 1000, data, 1, 5);
    expect(data[0]?.[0]).toBe(1); // before `offset`: untouched
    expect(data[0]?.[1]).toBeCloseTo(g * (0.5 / 4), 6);
    expect(data[1]?.[4]).toBeCloseTo(2 * g * (3.5 / 4), 6);
    expect(data[0]?.[5]).toBeCloseTo(g, 6);
    // Unity stays bit-exact.
    const plain = [new Float32Array([0.1, 0.2])];
    applyEnvelope(clip(), 2000, plain, 0, 2);
    expect(plain[0]).toEqual(new Float32Array([0.1, 0.2]));

    const out = [new Float32Array(4).fill(0.25), new Float32Array(4)];
    const mono = [new Float32Array([1, 2, 3, 4])];
    addClip(out, 1, mono, 0, 3, clip(), 5000, Math.SQRT1_2);
    expect(out[0]?.[0]).toBe(0.25);
    expect(out[0]?.[1]).toBeCloseTo(0.25 + Math.SQRT1_2, 6);
    expect(out[1]?.[3]).toBeCloseTo(3 * Math.SQRT1_2, 6);
    // A mono track gets one channel; a missing source adds nothing.
    const one = [new Float32Array(2)];
    addClip(one, 0, [new Float32Array([0.5, 0.5])], 0, 2, clip({ gainDb: -6 }), 5000, 1);
    expect(one[0]?.[1]).toBeCloseTo(0.5 * g, 6);
    addClip(one, 0, [], 0, 2, clip(), 5000, 1);
    addClip([], 0, mono, 0, 2, clip(), 5000, 1);
    expect(one[0]?.[1]).toBeCloseTo(0.5 * g, 6);
  });
});

describe("track layout (SPEC §24.5)", () => {
  const mono = variant({ channels: 1 });
  const dual = variant({ channels: 1, dualMono: true });
  const stereo = variant({ channels: 2 });

  it("is the widest clip, with mono up-mixed at the centre pan gain", () => {
    expect(trackLayout([])).toEqual({ channels: 2, dualMono: false });
    expect(trackLayout([clip({ variant: mono })])).toEqual({ channels: 1, dualMono: false });
    expect(trackLayout([clip({ variant: dual }), clip({ variant: dual })])).toEqual({
      channels: 1,
      dualMono: true,
    });
    const mixed = trackLayout([clip({ variant: mono }), clip({ variant: stereo })]);
    expect(mixed).toEqual({ channels: 2, dualMono: false });
    expect(trackLayout([clip({ variant: mono }), clip({ variant: dual })])).toEqual(mixed);
    expect(upmixGain(clip({ variant: mono }), mixed)).toBe(Math.SQRT1_2);
    expect(upmixGain(clip({ variant: dual }), mixed)).toBe(1);
    expect(upmixGain(clip({ variant: stereo }), mixed)).toBe(1);
    expect(upmixGain(clip({ variant: mono }), { channels: 1, dualMono: false })).toBe(1);
  });

  it("merges clip ranges for the mixer", () => {
    expect(
      clipRanges([
        clip({ startFrame: 500, lengthFrames: 100 }),
        clip({ startFrame: 0, lengthFrames: 200 }),
        clip({ startFrame: 150, lengthFrames: 100 }),
        clip({ startFrame: 250, lengthFrames: 50 }),
        clip({ startFrame: 900, lengthFrames: 0 }),
      ]),
    ).toEqual([
      { start: 0, end: 300 },
      { start: 500, end: 600 },
    ]);
  });
});

describe("fetch mode (SPEC §24.5)", () => {
  it("reads long Opus versions and FLAC in windows", () => {
    expect(fetchModeOf(variant())).toBe("whole");
    expect(fetchModeOf(variant({ kind: "flac" }))).toBe("window");
    expect(fetchModeOf(variant({ fetch: "window" }))).toBe("window");
    expect(defaultFetch(variant({ totalFrames: WINDOWED_OPUS_FRAMES }))).toBeUndefined();
    expect(defaultFetch(variant({ totalFrames: WINDOWED_OPUS_FRAMES + 1 }))).toBe("window");
    expect(defaultFetch(variant({ kind: "flac", totalFrames: 1e9 }))).toBeUndefined();
  });
});
