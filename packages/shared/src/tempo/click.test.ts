import { describe, expect, it } from "vitest";
import { clickFrames } from "./click";
import { MAX_PULSES, compileTempo } from "./math";
import type { Meter } from "./model";

const meter = (num: number, den: number): Meter => ({ num, den });
const constant = (bpm: number) =>
  compileTempo({
    map: { segments: [{ startBeat: 0, bpm, meter: meter(4, 4), barIndex: 0 }] },
    bar1OffsetSec: 0,
  });

describe("clickFrames", () => {
  it("covers recordings with more pulses than one call returns", () => {
    // 130 min at 400 BPM in sixteenths: 208 000 pulses, 1800 frames apart.
    const lengthFrames = 130 * 60 * 48_000;
    const t = clickFrames(constant(400), lengthFrames, {
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
    const t = clickFrames(g, 48_000, { subdivision: 1, compoundEighths: false });
    expect(Array.from(t.frames)).toEqual([12_000, 36_000]);
    expect(clickFrames(g, 0, { subdivision: 1, compoundEighths: false }).frames).toHaveLength(0);
  });

  it("follows tempo changes sample-accurately", () => {
    const g = compileTempo({
      map: {
        segments: [
          { startBeat: 0, bpm: 120, meter: meter(4, 4), barIndex: 0 },
          { startBeat: 4, bpm: 60, meter: meter(3, 4), barIndex: 1 },
        ],
      },
      bar1OffsetSec: 0,
    });
    const t = clickFrames(g, 6 * 48_000, { subdivision: 1, compoundEighths: false });
    expect(Array.from(t.frames)).toEqual([
      0, 24_000, 48_000, 72_000, 96_000, 144_000, 192_000, 240_000,
    ]);
    // Bar 2 is 3/4: the downbeat of bar 3 falls at 5 s.
    expect(Array.from(t.levels)).toEqual([0, 1, 1, 1, 0, 1, 1, 0]);
  });

  it("clicks compound meters on dotted beats, eighths on request, subdivided in thirds", () => {
    const g = compileTempo({
      map: { segments: [{ startBeat: 0, bpm: 120, meter: meter(6, 8), barIndex: 0 }] },
      bar1OffsetSec: 0,
    });
    const len = 72_000; // one 6/8 bar at 120 quarter BPM: 1.5 s
    const dotted = clickFrames(g, len, { subdivision: 1, compoundEighths: false });
    expect(Array.from(dotted.frames)).toEqual([0, 36_000]);
    expect(Array.from(dotted.levels)).toEqual([0, 1]);
    const eighths = clickFrames(g, len, { subdivision: 1, compoundEighths: true });
    expect(Array.from(eighths.frames)).toEqual([0, 12_000, 24_000, 36_000, 48_000, 60_000]);
    expect(Array.from(eighths.levels)).toEqual([0, 1, 1, 1, 1, 1]);
    const thirds = clickFrames(g, len, { subdivision: 2, compoundEighths: false });
    expect(Array.from(thirds.frames)).toEqual(Array.from(eighths.frames));
    expect(Array.from(thirds.levels)).toEqual([0, 2, 2, 1, 2, 2]);
  });
});
