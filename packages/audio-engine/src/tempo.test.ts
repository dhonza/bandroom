import { compileTempo, MAX_PULSES, type Meter } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { clickTrackFor, countInSpecAt } from "./tempo";

const meter = (num: number, den: number): Meter => ({ num, den });
const constant = (bpm: number) =>
  compileTempo({
    map: { segments: [{ startBeat: 0, bpm, meter: meter(4, 4), barIndex: 0 }] },
    bar1OffsetSec: 0,
  });

describe("clickTrackFor", () => {
  it("covers recordings with more pulses than one call returns", () => {
    // 130 min at 400 BPM in sixteenths: 208 000 pulses, 1800 frames apart.
    const lengthFrames = 130 * 60 * 48_000;
    const t = clickTrackFor(constant(400), lengthFrames, {
      subdivision: 4,
      compoundEighths: false,
    });
    expect(t.frames.length).toBe(208_000);
    expect(t.frames.length).toBeGreaterThan(MAX_PULSES);
    for (let i = 1; i < t.frames.length; i++) {
      if ((t.frames[i] ?? 0) - (t.frames[i - 1] ?? 0) !== 1800) throw new Error(`gap at ${i}`);
    }
    expect(t.frames.at(-1)).toBe(207_999 * 1800);
    // Downbeats every 16 pulses (bar), beats every 4, subdivisions between.
    expect(Array.from(t.levels.slice(0, 5))).toEqual([0, 2, 2, 2, 1]);
    expect(t.levels[16 * 10_000]).toBe(0);
  });

  it("keeps pulses inside the song only", () => {
    const g = compileTempo({
      map: { segments: [{ startBeat: 0, bpm: 120, meter: meter(4, 4), barIndex: 0 }] },
      bar1OffsetSec: 0.25, // a pickup: pulses before 0 s are dropped
    });
    const t = clickTrackFor(g, 48_000, { subdivision: 1, compoundEighths: false });
    expect(Array.from(t.frames)).toEqual([12_000, 36_000]);
    expect(clickTrackFor(g, 0, { subdivision: 1, compoundEighths: false }).frames).toHaveLength(0);
  });
});

describe("countInSpecAt", () => {
  it("converts the count-in at a frame to frames", () => {
    expect(countInSpecAt(constant(120), 48_000, 1, false)).toEqual({
      clicks: 4,
      perBar: 4,
      intervalFrames: 24_000,
    });
  });
});
