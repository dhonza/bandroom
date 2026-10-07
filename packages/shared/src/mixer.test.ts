import { describe, expect, it } from "vitest";
import { dimmedTrackIds, type MixerTrackState } from "./mixer";

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
