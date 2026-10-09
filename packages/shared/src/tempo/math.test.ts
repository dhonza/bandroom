import { describe, expect, it } from "vitest";
import {
  barAtBeat,
  barBeatToSec,
  barByIndex,
  beatsInBar,
  beatToSec,
  bpmAtBeat,
  clickPulses,
  compileTempo,
  countInAt,
  formatBarBeat,
  gridLines,
  MAX_PULSES,
  secToBarBeat,
  secToBeat,
  snapToGrid,
  stepGrid,
  tempoAt,
  type TempoGrid,
} from "./math";
import { normalizeSegments, type TempoSegmentInput } from "./model";

const m = (num: number, den: number) => ({ num, den });

function grid(segments: TempoSegmentInput[], bar1OffsetSec = 0): TempoGrid {
  const r = normalizeSegments(segments);
  if (!r.ok) throw new Error(r.issue.code);
  return compileTempo({ map: { segments: r.segments }, bar1OffsetSec });
}

const constant = (bpm = 120, meter = m(4, 4), offset = 0) =>
  grid([{ startBeat: 0, bpm, meter }], offset);

/** 4/4 for 2 bars, 3/4 for 2 bars at 60 BPM from bar 2 beat 3, 6/8 at 90 from bar 5. */
const changes = () =>
  grid([
    { startBeat: 0, bpm: 120, meter: m(4, 4) },
    { startBeat: 6, bpm: 60, meter: m(4, 4) },
    { startBeat: 8, bpm: 60, meter: m(3, 4) },
    { startBeat: 14, bpm: 90, meter: m(6, 8) },
  ]);

describe("conversions (SPEC §7.1)", () => {
  it("converts beats and seconds at a constant tempo with a bar 1 offset", () => {
    const g = constant(120, m(4, 4), 0.5);
    expect(beatToSec(g, 0)).toBe(0.5);
    expect(beatToSec(g, 4)).toBeCloseTo(2.5, 12);
    expect(secToBeat(g, 2.5)).toBeCloseTo(4, 12);
    expect(bpmAtBeat(g, 3)).toBe(120);
  });

  it("extends the grid backwards: pickup bars are 0, −1, … (negative beats)", () => {
    const g = constant(120, m(4, 4), 0.5);
    expect(secToBeat(g, 0)).toBeCloseTo(-1, 12);
    expect(beatToSec(g, -1)).toBeCloseTo(0, 12);
    expect(bpmAtBeat(g, -2)).toBe(120);
    expect(barAtBeat(g, -1)).toEqual({ index: -1, startBeat: -4, meter: m(4, 4) });
    expect(secToBarBeat(g, 0)).toEqual({ bar: 0, beat: 4, tick: 1 });
    expect(barBeatToSec(g, 0, 4)).toBeCloseTo(0, 12);
    expect(barBeatToSec(g, -1, 1)).toBeCloseTo(0.5 - 4, 12);
  });

  it("steps the tempo and follows meter changes at bar lines", () => {
    const g = changes();
    expect(beatToSec(g, 6)).toBeCloseTo(3, 12);
    expect(beatToSec(g, 8)).toBeCloseTo(5, 12); // 2 beats at 60
    expect(beatToSec(g, 14)).toBeCloseTo(11, 12);
    expect(beatToSec(g, 15.5)).toBeCloseTo(12, 12); // 1.5 beats at 90
    for (const b of [-3, 0.25, 6.5, 8, 13.99, 14, 20.75]) {
      expect(secToBeat(g, beatToSec(g, b))).toBeCloseTo(b, 9);
    }
    expect(barAtBeat(g, 8)).toEqual({ index: 2, startBeat: 8, meter: m(3, 4) });
    // A rounding error below a meter change still lands in the new bar with the new meter.
    expect(barAtBeat(g, 8 - 1e-12)).toEqual({ index: 2, startBeat: 8, meter: m(3, 4) });
    expect(barByIndex(g, 4)).toEqual({ index: 4, startBeat: 14, meter: m(6, 8) });
    expect(barByIndex(g, 6).startBeat).toBe(20);
    expect(barByIndex(g, -2).startBeat).toBe(-8);
    expect(beatsInBar(g, 1)).toBe(4);
    expect(beatsInBar(g, 3)).toBe(3);
    expect(beatsInBar(g, 6)).toBe(2);
    expect(tempoAt(g, 12)).toEqual({ bpm: 90, meter: m(6, 8) });
  });

  it("reads bar.beat.tick in simple and compound meters and converts back", () => {
    const g = changes();
    expect(secToBarBeat(g, beatToSec(g, 1.25))).toEqual({ bar: 1, beat: 2, tick: 2 });
    expect(secToBarBeat(g, beatToSec(g, 9))).toEqual({ bar: 3, beat: 2, tick: 1 });
    // 6/8: two dotted beats, ticks are eighths.
    expect(secToBarBeat(g, beatToSec(g, 14 + 1.5 + 0.5))).toEqual({ bar: 5, beat: 2, tick: 2 });
    expect(barBeatToSec(g, 5, 2, 2)).toBeCloseTo(beatToSec(g, 16), 12);
    expect(barBeatToSec(g, 3)).toBeCloseTo(5, 12);
    expect(formatBarBeat({ bar: 17, beat: 3, tick: 2 })).toBe("17.3");
    expect(formatBarBeat({ bar: 17, beat: 3, tick: 2 }, true)).toBe("17.3.2");
  });

  it("ramps the tempo linearly in beats and inverts it exactly", () => {
    const g = grid([
      { startBeat: 0, bpm: 60, bpmEnd: 120, meter: m(4, 4) },
      { startBeat: 4, bpm: 120, meter: m(4, 4) },
    ]);
    const rampSec = (60 / 15) * Math.log(2); // slope 15 BPM per beat
    expect(beatToSec(g, 4)).toBeCloseTo(rampSec, 12);
    expect(beatToSec(g, 6)).toBeCloseTo(rampSec + 1, 12);
    expect(bpmAtBeat(g, 2)).toBe(90);
    for (const b of [0.5, 1, 2.5, 3.999, 5]) {
      expect(secToBeat(g, beatToSec(g, b))).toBeCloseTo(b, 9);
    }
    // A ramp on the last segment (no end) is treated as constant.
    const last = compileTempo({
      map: { segments: [{ startBeat: 0, bpm: 100, bpmEnd: 200, meter: m(4, 4), barIndex: 0 }] },
      bar1OffsetSec: 0,
    });
    expect(beatToSec(last, 10)).toBeCloseTo(6, 12);
  });
});

describe("grid, pulses and snapping (SPEC §6.7, §7.5)", () => {
  it("lists bar, beat and subdivision lines", () => {
    const g = constant(120);
    const bars = gridLines(g, 0, 4, "bar");
    expect(bars.map((l) => [l.sec, l.bar, l.level])).toEqual([
      [0, 1, 0],
      [2, 2, 0],
      [4, 3, 0],
    ]);
    const beats = gridLines(g, 0.9, 2.1, "beat");
    expect(beats.map((l) => [l.sec, l.level])).toEqual([
      [1, 1],
      [1.5, 1],
      [2, 0],
    ]);
    expect(gridLines(g, 0, 0.5, "half").map((l) => l.level)).toEqual([0, 2, 1]);
    expect(gridLines(g, 0, 0.5, "quarter")).toHaveLength(5);
    expect(gridLines(g, 2, 1, "beat")).toEqual([]);
    expect(gridLines(g, Number.NaN, 1, "beat")).toEqual([]);
  });

  it("splits compound beats in eighths and sixteenths", () => {
    const g = constant(90, m(6, 8)); // dotted beat = 1 s, eighth = 1/3 s
    expect(gridLines(g, 0, 1.99, "beat").map((l) => l.sec)).toEqual([0, 1]);
    const halves = gridLines(g, 0, 0.99, "half").map((l) => l.sec);
    expect(halves).toHaveLength(3);
    [0, 1 / 3, 2 / 3].forEach((x, i) => {
      expect(halves[i]).toBeCloseTo(x, 9);
    });
    expect(gridLines(g, 0, 0.99, "quarter")).toHaveLength(6);
  });

  it("builds click pulses with accents, subdivisions and compound options", () => {
    const g = changes();
    const whole = clickPulses(g, 0, 11, { subdivision: 1, compoundEighths: false });
    // 2 bars of 4, 2 bars of 3, then the first 6/8 downbeat at 11 s.
    expect(whole.map((p) => p.level)).toEqual([0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0]);
    expect(whole.at(-1)?.sec).toBeCloseTo(11, 12);
    const subs = clickPulses(g, 0, 0.99, { subdivision: 2, compoundEighths: false });
    expect(subs.map((p) => p.level)).toEqual([0, 2, 1, 2]);
    const six = constant(90, m(6, 8));
    expect(clickPulses(six, 0, 1.99, { subdivision: 1, compoundEighths: false })).toHaveLength(2);
    expect(clickPulses(six, 0, 1.99, { subdivision: 2, compoundEighths: false })).toHaveLength(6);
    const eighths = clickPulses(six, 0, 1.99, { subdivision: 1, compoundEighths: true });
    expect(eighths.map((p) => p.level)).toEqual([0, 1, 1, 1, 1, 1]);
    const sixteenths = clickPulses(six, 0, 0.99, { subdivision: 2, compoundEighths: true });
    expect(sixteenths.map((p) => p.level)).toEqual([0, 2, 1, 2, 1, 2]);
  });

  it("caps the number of pulses per call", () => {
    const g = constant(400);
    expect(gridLines(g, 0, 10_000, "quarter")).toHaveLength(MAX_PULSES);
  });

  it("snaps to the nearest line and steps to the next or previous one", () => {
    const g = changes();
    expect(snapToGrid(g, 0.74, "beat")).toBeCloseTo(0.5, 12);
    expect(snapToGrid(g, 0.76, "beat")).toBeCloseTo(1, 12);
    expect(snapToGrid(g, 1.2, "bar")).toBeCloseTo(2, 12);
    expect(snapToGrid(g, 0.3, "quarter")).toBeCloseTo(0.25, 12);
    expect(stepGrid(g, 1, 1, "beat")).toBeCloseTo(1.5, 12);
    expect(stepGrid(g, 1, -1, "beat")).toBeCloseTo(0.5, 12);
    expect(stepGrid(g, 1.2, -1, "beat")).toBeCloseTo(1, 12);
    expect(stepGrid(g, 1.2, 1, "bar")).toBeCloseTo(2, 12);
    expect(stepGrid(g, 5, -1, "bar")).toBeCloseTo(2, 12); // bar 2 starts at 2 s
  });

  it("counts in with the tempo and meter at the start position", () => {
    const g = changes();
    expect(countInAt(g, 0, 1, false)).toEqual({ clicks: 4, perBar: 4, intervalSec: 0.5 });
    expect(countInAt(g, 5, 2, false)).toEqual({ clicks: 6, perBar: 3, intervalSec: 1 });
    expect(countInAt(g, 11, 1, false)).toEqual({ clicks: 2, perBar: 2, intervalSec: 1 });
    const e = countInAt(g, 11, 2, true);
    expect(e.clicks).toBe(12);
    expect(e.perBar).toBe(6);
    expect(e.intervalSec).toBeCloseTo(1 / 3, 12);
  });
});

describe("new-bar segments (SPEC §24.4)", () => {
  it("start a new bar region off the old grid", () => {
    const g = grid([
      { startBeat: 0, bpm: 120, meter: m(4, 4) },
      { startBeat: 6, bpm: 120, meter: m(4, 4), newBar: true },
    ]);
    expect(barAtBeat(g, 5.9)).toEqual({ index: 1, startBeat: 4, meter: m(4, 4) });
    expect(barAtBeat(g, 6)).toEqual({ index: 2, startBeat: 6, meter: m(4, 4) });
    expect(barAtBeat(g, 10.5)).toEqual({ index: 3, startBeat: 10, meter: m(4, 4) });
  });
});
