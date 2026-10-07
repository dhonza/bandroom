import { describe, expect, it } from "vitest";
import { countInAt, NO_REPORT, playheadAt, type Report } from "./playhead";

const report = (over: Partial<Report> = {}): Report => ({ ...NO_REPORT, ...over });

describe("playheadAt", () => {
  it("advances from the report by the frames heard", () => {
    expect(playheadAt(report({ frame: 1000 }), 480, null, null, 100_000)).toBe(1480);
  });

  it("holds while a count-in plays, then continues", () => {
    const r = report({ frame: 1000, preroll: 4800 });
    expect(playheadAt(r, 2400, null, null, 100_000)).toBe(1000);
    expect(playheadAt(r, 6000, null, null, 100_000)).toBe(2200);
  });

  it("stops at the song end", () => {
    expect(playheadAt(report({ frame: 9000 }), 5000, null, null, 10_000)).toBe(10_000);
  });

  it("wraps at the loop end", () => {
    const loop = { start: 1000, end: 5000 };
    expect(playheadAt(report({ frame: 4000 }), 1500, loop, null, 100_000)).toBe(1500);
    // Several laps ahead stays inside the loop.
    expect(playheadAt(report({ frame: 4000 }), 9500, loop, null, 100_000)).toBe(1500);
  });

  it("does not wrap when the report is already past the loop end", () => {
    const loop = { start: 1000, end: 5000 };
    expect(playheadAt(report({ frame: 6000 }), 500, loop, null, 100_000)).toBe(6500);
  });

  it("holds at the loop start before a repeat count-in", () => {
    const loop = { start: 1000, end: 5000 };
    const ci = { clicks: 4, intervalFrames: 24_000, perBar: 4 };
    expect(playheadAt(report({ frame: 4000 }), 1500, loop, ci, 100_000)).toBe(1000);
    // An empty repeat count-in wraps normally.
    const none = { clicks: 0, intervalFrames: 24_000, perBar: 4 };
    expect(playheadAt(report({ frame: 4000 }), 1500, loop, none, 100_000)).toBe(1500);
  });
});

describe("countInAt", () => {
  const ci = report({ preroll: 4 * 24_000, prerollInterval: 24_000, prerollClicks: 4 });

  it("is null without a count-in", () => {
    expect(countInAt(report(), 0)).toBeNull();
    expect(countInAt(report({ preroll: 100, prerollInterval: 0, prerollClicks: 4 }), 0)).toBeNull();
  });

  it("counts the beats being heard", () => {
    expect(countInAt(ci, 0)).toEqual({ beat: 1, clicks: 4 });
    expect(countInAt(ci, 23_999)).toEqual({ beat: 1, clicks: 4 });
    expect(countInAt(ci, 24_000)).toEqual({ beat: 2, clicks: 4 });
    expect(countInAt(ci, 3 * 24_000 + 10)).toEqual({ beat: 4, clicks: 4 });
  });

  it("continues a count-in already under way at the report", () => {
    const r = report({ preroll: 2 * 24_000, prerollInterval: 24_000, prerollClicks: 4 });
    expect(countInAt(r, 0)).toEqual({ beat: 3, clicks: 4 });
  });

  it("ends once the count-in has been heard", () => {
    expect(countInAt(ci, 4 * 24_000)).toBeNull();
  });
});
