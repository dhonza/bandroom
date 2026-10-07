import { describe, expect, it } from "vitest";
import { clickSampleLevel, clickSamples, CLICK_SOUNDS, synthClick } from "./click";

describe("click sounds (SPEC §6.7)", () => {
  it("are deterministic, 20–40 ms, and start silent", () => {
    for (const s of CLICK_SOUNDS) {
      const a = synthClick(s, 0);
      expect(Array.from(a)).toEqual(Array.from(synthClick(s, 0)));
      expect(a.length).toBeGreaterThanOrEqual(960);
      expect(a.length).toBeLessThanOrEqual(1920);
      expect(Math.abs(a[0] ?? 1)).toBe(0);
      expect(clickSamples(s)).toHaveLength(3);
    }
  });

  it("maps pulse levels to samples; with the accent off downbeats sound like beats", () => {
    expect([0, 1, 2].map((l) => clickSampleLevel(l, true))).toEqual([0, 1, 2]);
    expect([0, 1, 2].map((l) => clickSampleLevel(l, false))).toEqual([1, 1, 2]);
  });
});
