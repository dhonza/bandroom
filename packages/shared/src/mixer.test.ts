import { describe, expect, it } from "vitest";
import { clickAudible, clickSettingsOf, dimmedTrackIds, type MixerTrackState } from "./mixer";

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
