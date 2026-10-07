import type { Track } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { readyTrackCount, shouldPlayDefaultMix } from "./defaultMix";

const f = (over: Partial<Parameters<typeof shouldPlayDefaultMix>[0]> = {}) => ({
  open: false,
  trackCount: 2,
  mixPlayable: false,
  held: false,
  enginePlaying: false,
  ...over,
});

describe("shouldPlayDefaultMix (SPEC §25.5)", () => {
  it("plays the tracks with the default mix while there is no mix", () => {
    expect(shouldPlayDefaultMix(f())).toBe(true);
  });

  it("not with the Mixer open, before the decision, or without tracks", () => {
    expect(shouldPlayDefaultMix(f({ open: true }))).toBe(false);
    expect(shouldPlayDefaultMix(f({ open: null }))).toBe(false);
    expect(shouldPlayDefaultMix(f({ trackCount: 0 }))).toBe(false);
  });

  it("switches to a ready mix, but not in the middle of playback", () => {
    expect(shouldPlayDefaultMix(f({ mixPlayable: true }))).toBe(false);
    expect(shouldPlayDefaultMix(f({ mixPlayable: true, held: true, enginePlaying: true }))).toBe(
      true,
    );
    expect(shouldPlayDefaultMix(f({ mixPlayable: true, held: true }))).toBe(false);
    // A song that had its mix all along does not start on the default mix.
    expect(shouldPlayDefaultMix(f({ mixPlayable: true, enginePlaying: true }))).toBe(false);
  });
});

describe("readyTrackCount", () => {
  const t = (status: string | null, opus = true) =>
    ({
      current: status === null ? null : { status, variants: { opus: opus ? { hash: "h" } : null } },
    }) as unknown as Track;

  it("counts tracks whose current version can play", () => {
    expect(readyTrackCount([t("ready"), t("queued"), t(null), t("ready", false)])).toBe(1);
    expect(readyTrackCount([])).toBe(0);
  });
});
