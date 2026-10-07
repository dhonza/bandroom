import { describe, expect, it } from "vitest";
import { isLossyVersion, songLossyOf } from "./lossless";

describe("lossy state (SPEC §26.4)", () => {
  it("a version is lossy when its source was or its full quality was removed", () => {
    expect(isLossyVersion({ media: { lossless: true }, archived: null })).toBe(false);
    expect(isLossyVersion({ media: { lossless: false }, archived: null })).toBe(true);
    expect(
      isLossyVersion({
        media: { lossless: true },
        archived: { at: 1, by: null, reason: "removed" },
      }),
    ).toBe(true);
    expect(isLossyVersion({ media: null, archived: null })).toBe(false);
  });

  it("a song is lossy when all, partly lossy when some current versions are", () => {
    expect(songLossyOf([])).toBe("none");
    expect(songLossyOf([false, false])).toBe("none");
    expect(songLossyOf([true, false])).toBe("partial");
    expect(songLossyOf([true, true])).toBe("all");
  });
});
