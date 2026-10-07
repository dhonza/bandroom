import { describe, expect, it } from "vitest";
import { BOUNCE_MAX_TRACKS, BounceRequestSchema, bounceTracks } from "./bounce";
import type { MixerTrackState } from "./mixer";

const s = (over: Partial<MixerTrackState> = {}): MixerTrackState => ({
  gainDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  listenedVersionId: null,
  ...over,
});
const none = () => undefined;

describe("BounceRequestSchema (SPEC §5.5)", () => {
  const base = { title: " Song (bounce) ", mix: { tracks: {} }, versions: { t1: "v1" } };

  it("accepts a title, the mix and the versions; trims the title", () => {
    const r = BounceRequestSchema.parse(base);
    expect(r.title).toBe("Song (bounce)");
    expect(r.versions).toEqual({ t1: "v1" });
  });

  it("needs a title and 1 to BOUNCE_MAX_TRACKS versions", () => {
    expect(BounceRequestSchema.safeParse({ ...base, title: "  " }).success).toBe(false);
    expect(BounceRequestSchema.safeParse({ ...base, versions: {} }).success).toBe(false);
    const tracks = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, `v${i}`]));
    const parse = (n: number) =>
      BounceRequestSchema.safeParse({ ...base, versions: tracks(n) }).success;
    expect(parse(BOUNCE_MAX_TRACKS + 1)).toBe(false);
    expect(parse(BOUNCE_MAX_TRACKS)).toBe(true);
  });

  it("validates the mixer state like the mixer route", () => {
    const bad = { ...base, mix: { tracks: { t1: { ...s(), gainDb: 20 } } } };
    expect(BounceRequestSchema.safeParse(bad).success).toBe(false);
  });
});

describe("bounceTracks (engine rules, SPEC §5.5, §6.6)", () => {
  const versions = { a: "va", b: "vb", c: "vc" };

  it("keeps every audible track with its fader and pan", () => {
    const mix = { tracks: { a: s({ gainDb: -6, pan: -0.5 }), b: s({ pan: 1 }), c: s() } };
    expect(bounceTracks(versions, mix, none)).toEqual([
      { trackId: "a", versionId: "va", gainDb: -6, pan: -0.5 },
      { trackId: "b", versionId: "vb", gainDb: 0, pan: 1 },
      { trackId: "c", versionId: "vc", gainDb: 0, pan: 0 },
    ]);
  });

  it("leaves out muted tracks", () => {
    const mix = { tracks: { a: s(), b: s({ mute: true }), c: s() } };
    expect(bounceTracks(versions, mix, none).map((t) => t.trackId)).toEqual(["a", "c"]);
  });

  it("with a solo keeps only the soloed tracks (a muted solo stays silent)", () => {
    const mix = { tracks: { a: s({ solo: true }), b: s(), c: s({ solo: true, mute: true }) } };
    expect(bounceTracks(versions, mix, none).map((t) => t.trackId)).toEqual(["a"]);
  });

  it("counts solos among the bounced tracks only, like the engine", () => {
    // Track d is soloed in the mix but not loaded (no version): it does not silence the others.
    const mix = { tracks: { a: s(), b: s(), c: s(), d: s({ solo: true }) } };
    expect(bounceTracks(versions, mix, none)).toHaveLength(3);
  });

  it("drops a fader at the bottom", () => {
    const mix = { tracks: { a: s({ gainDb: -120 }), b: s(), c: s() } };
    expect(bounceTracks(versions, mix, none).map((t) => t.trackId)).toEqual(["b", "c"]);
  });

  it("uses the track's default mix when the personal mix has no entry", () => {
    const defaults = (id: string) =>
      id === "b" ? s({ mute: true }) : id === "c" ? s({ gainDb: -3, pan: 0.25 }) : undefined;
    expect(bounceTracks(versions, { tracks: { a: s() } }, defaults)).toEqual([
      { trackId: "a", versionId: "va", gainDb: 0, pan: 0 },
      { trackId: "c", versionId: "vc", gainDb: -3, pan: 0.25 },
    ]);
  });

  it("returns nothing when everything is silent", () => {
    const mix = { tracks: { a: s({ mute: true }), b: s({ mute: true }), c: s({ mute: true }) } };
    expect(bounceTracks(versions, mix, none)).toEqual([]);
  });
});
