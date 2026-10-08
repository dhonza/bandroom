import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRACTICE,
  MixerStateSchema,
  clickAudible,
  clickSettingsOf,
  dimmedTrackIds,
  isNeutralPractice,
  practiceOf,
  type MixerTrackState,
} from "./mixer";

const trackState = (over: Partial<MixerTrackState> = {}): MixerTrackState => ({
  gainDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  listenedVersionId: null,
  ...over,
});

describe("dimmedTrackIds", () => {
  it("lists muted tracks and, with a solo, the unsoloed ones; faders do not matter", () => {
    const s = trackState;
    expect(dimmedTrackIds({ tracks: { b: s({ mute: true }), a: s() } })).toEqual(["b"]);
    expect(
      dimmedTrackIds({ tracks: { c: s({ solo: true }), b: s({ gainDb: -6 }), a: s() } }),
    ).toEqual(["a", "b"]);
    expect(dimmedTrackIds({ tracks: { a: s({ gainDb: -20, pan: 0.5 }) } })).toEqual([]);
    // A muted solo track stays silent.
    expect(dimmedTrackIds({ tracks: { a: s({ solo: true, mute: true }), b: s() } })).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("the click in the mix (SPEC §6.6, §6.7)", () => {
  const s = trackState;
  it("a soloed click silences the unsoloed tracks, like the engine", () => {
    expect(
      dimmedTrackIds({ tracks: { a: s(), b: s({ solo: true }) }, click: { solo: true } }),
    ).toEqual(["a"]);
    expect(dimmedTrackIds({ tracks: { a: s() }, click: { solo: false } })).toEqual([]);
  });

  it("is audible when on, unless a soloed track excludes it", () => {
    expect(clickSettingsOf({}).enabled).toBe(false);
    expect(clickAudible({ tracks: {} })).toBe(false);
    expect(clickAudible({ tracks: {}, click: { enabled: true } })).toBe(true);
    const solo = { a: s({ solo: true }) };
    // Solo-safe by default.
    expect(clickAudible({ tracks: solo, click: { enabled: true } })).toBe(true);
    expect(clickAudible({ tracks: solo, click: { enabled: true, soloExcludes: true } })).toBe(
      false,
    );
    expect(
      clickAudible({ tracks: solo, click: { enabled: true, soloExcludes: true, solo: true } }),
    ).toBe(true);
  });
});

describe("the practice setting (SPEC §30.2)", () => {
  it("is optional and partial, with defaults for missing keys", () => {
    expect(MixerStateSchema.safeParse({ tracks: {} }).success).toBe(true);
    expect(MixerStateSchema.safeParse({ tracks: {}, practice: { rate: 0.85 } }).success).toBe(true);
    expect(practiceOf({})).toEqual(DEFAULT_PRACTICE);
    expect(practiceOf({ practice: { semitones: -2 } })).toEqual({
      rate: 1,
      semitones: -2,
      cents: 0,
    });
  });

  it("refuses values out of range", () => {
    const bad = [
      { rate: 0.2 },
      { rate: 2.5 },
      { semitones: 25 },
      { semitones: 1.5 },
      { cents: -101 },
    ];
    for (const practice of bad) {
      expect(MixerStateSchema.safeParse({ tracks: {}, practice }).success).toBe(false);
    }
  });

  it("is neutral only at the original speed and pitch", () => {
    expect(isNeutralPractice(DEFAULT_PRACTICE)).toBe(true);
    expect(isNeutralPractice({ ...DEFAULT_PRACTICE, rate: 0.5 })).toBe(false);
    expect(isNeutralPractice({ ...DEFAULT_PRACTICE, semitones: 1 })).toBe(false);
    expect(isNeutralPractice({ ...DEFAULT_PRACTICE, cents: -32 })).toBe(false);
  });
});
