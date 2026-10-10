import { compileTempo, normalizeSegments, type TempoSegmentInput } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { hasMeterChanges } from "./meterChanges";

const m = (num: number, den: number) => ({ num, den });

function grid(segments: TempoSegmentInput[]) {
  const r = normalizeSegments(segments);
  if (!r.ok) throw new Error(r.issue.code);
  return compileTempo({ map: { segments: r.segments }, bar1OffsetSec: 0 });
}

describe("hasMeterChanges (SPEC §31.5)", () => {
  it("is false without a tempo map or regions", () => {
    expect(hasMeterChanges(null)).toBe(false);
    expect(hasMeterChanges({ offset: 0, segs: [], regions: [] })).toBe(false);
  });

  it("is false for one meter, also with tempo changes and new bars", () => {
    expect(hasMeterChanges(grid([{ startBeat: 0, bpm: 120, meter: m(4, 4) }]))).toBe(false);
    expect(
      hasMeterChanges(
        grid([
          { startBeat: 0, bpm: 120, meter: m(4, 4) },
          { startBeat: 6, bpm: 140, meter: m(4, 4), newBar: true },
        ]),
      ),
    ).toBe(false);
  });

  it("is true when the meter changes", () => {
    expect(
      hasMeterChanges(
        grid([
          { startBeat: 0, bpm: 120, meter: m(4, 4) },
          { startBeat: 8, bpm: 120, meter: m(7, 8) },
        ]),
      ),
    ).toBe(true);
  });
});
