import { compileTempo, type Meter } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { clickLaneTicks, type ClickLane } from "./clickLane";

const m = (num: number, den: number): Meter => ({ num, den });

const lane = (over: Partial<ClickLane> = {}): ClickLane => ({
  grid: compileTempo({
    map: {
      segments: [
        { startBeat: 0, bpm: 120, meter: m(4, 4), barIndex: 0 },
        // Bar 3 on: 6/8 at 60 quarter BPM (dotted quarters every 1.5 s).
        { startBeat: 8, bpm: 60, meter: m(6, 8), barIndex: 2 },
      ],
    },
    bar1OffsetSec: 0,
  }),
  subdivision: 1,
  compoundEighths: false,
  accent: true,
  ...over,
});

const at = (ticks: { sec: number; level: number }[]) => ticks.map((t) => [t.sec, t.level]);

describe("click lane ticks (SPEC §11.3, §6.7)", () => {
  it("follows the tempo map across a tempo and meter change", () => {
    expect(at(clickLaneTicks(lane(), 0, 7, 100))).toEqual([
      [0, 0],
      [0.5, 1],
      [1, 1],
      [1.5, 1],
      [2, 0],
      [2.5, 1],
      [3, 1],
      [3.5, 1],
      // 6/8 at 60: dotted quarters 1.5 s apart, bars of 3 s.
      [4, 0],
      [5.5, 1],
      [7, 0],
    ]);
  });

  it("ticks compound eighths and subdivisions like the click", () => {
    expect(at(clickLaneTicks(lane({ compoundEighths: true }), 4, 6.9, 100))).toEqual([
      [4, 0],
      [4.5, 1],
      [5, 1],
      [5.5, 1],
      [6, 1],
      [6.5, 1],
    ]);
    expect(at(clickLaneTicks(lane({ subdivision: 2 }), 0, 0.9, 100))).toEqual([
      [0, 0],
      [0.25, 2],
      [0.5, 1],
      [0.75, 2],
    ]);
  });

  it("draws downbeats as beats without the accent", () => {
    expect(clickLaneTicks(lane({ accent: false }), 0, 0.1, 100)[0]?.level).toBe(1);
  });

  it("thins out ticks that would be closer than a few pixels", () => {
    const sub = lane({ subdivision: 4 });
    // Sixteenths are 0.125 s apart: 2.5 px at 20 px/s, beats 10 px.
    expect(new Set(clickLaneTicks(sub, 0, 3.9, 20).map((t) => t.level))).toEqual(new Set([0, 1]));
    // Beats 2 px apart at 4 px/s: bars only.
    expect(new Set(clickLaneTicks(sub, 0, 3.9, 4).map((t) => t.level))).toEqual(new Set([0]));
    expect(clickLaneTicks(sub, 0, 0.9, 1000)).toHaveLength(8);
  });
});
