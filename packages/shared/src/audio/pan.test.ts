import { describe, expect, it } from "vitest";
import { dbToGain, panGains, panGainsInto } from "./pan";

const close = (a: number, b: number) => {
  expect(a).toBeCloseTo(b, 6);
};

describe("panGains", () => {
  it("mono: −3 dB at center, hard left/right, constant power", () => {
    const c = panGains(0, "mono");
    close(c.left, Math.SQRT1_2);
    close(c.right, Math.SQRT1_2);
    close(panGains(-1, "mono").left, 1);
    close(panGains(-1, "mono").right, 0);
    close(panGains(1, "mono").right, 1);
    for (const p of [-0.7, -0.2, 0.3, 0.9]) {
      const g = panGains(p, "mono");
      close(g.left ** 2 + g.right ** 2, 1);
    }
  });

  it("stereo: unity at center, attenuates only the opposite side", () => {
    expect(panGains(0, "stereo")).toEqual({ left: 1, right: 1 });
    const r = panGains(0.5, "stereo");
    close(r.right, 1);
    expect(r.left).toBeLessThan(1);
    close(panGains(-1, "stereo").right, 0);
    expect(panGains(2, "stereo")).toEqual(panGains(1, "stereo"));
  });

  it("panGainsInto writes the same gains into the given object", () => {
    const out = { left: 9, right: 9 };
    for (const src of ["mono", "stereo"] as const) {
      for (const p of [-1, -0.4, 0, 0.6, 1]) {
        expect(panGainsInto(p, src, out)).toBe(out);
        expect(out).toEqual(panGains(p, src));
      }
    }
  });
});

describe("dbToGain", () => {
  it("converts and treats the fader bottom as silence", () => {
    close(dbToGain(0), 1);
    close(dbToGain(6), 1.9952623);
    close(dbToGain(-6), 0.5011872);
    expect(dbToGain(-120)).toBe(0);
    expect(dbToGain(-Infinity)).toBe(0);
  });
});
