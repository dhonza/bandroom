import { describe, expect, it } from "vitest";
import { normalizeSegments, type TempoMap, type TempoSegmentInput } from "@bandroom/shared";
import {
  addChangeAtBar,
  addTap,
  formatBpmRange,
  mapFromRows,
  parseMeter,
  rowsFromMap,
  summarize,
  tapBpm,
  type ChangeRow,
  type HeadRow,
} from "./model";

const four = { num: 4, den: 4 };

describe("tap tempo (SPEC §7.3)", () => {
  it("averages the last 4–8 taps and restarts after a pause", () => {
    let taps: number[] = [];
    for (const t of [0, 500, 1000]) taps = addTap(taps, t);
    expect(tapBpm(taps)).toBeNull();
    taps = addTap(taps, 1500);
    expect(tapBpm(taps)).toBe(120);
    for (let i = 4; i < 12; i++) taps = addTap(taps, i * 500 + (i % 2) * 10);
    expect(taps).toHaveLength(8);
    expect(tapBpm(taps)).toBeCloseTo(120, 0);
    taps = addTap(taps, 20_000);
    expect(taps).toEqual([20_000]);
    expect(tapBpm([0, 0, 0, 0])).toBeNull();
  });
});

describe("tempo form helpers", () => {
  it("parses meters", () => {
    expect(parseMeter("6/8")).toEqual({ num: 6, den: 8 });
    expect(parseMeter(" 7 / 8 ")).toEqual({ num: 7, den: 8 });
    expect(parseMeter("4/3")).toBeNull();
    expect(parseMeter("0/4")).toBeNull();
    expect(parseMeter("x")).toBeNull();
  });

  it("summarizes maps", () => {
    const s = summarize({
      segments: [
        { startBeat: 0, bpm: 96, meter: four, barIndex: 0 },
        { startBeat: 8, bpm: 128, bpmEnd: 130, meter: { num: 7, den: 8 }, barIndex: 2 },
        { startBeat: 15, bpm: 128, meter: { num: 7, den: 8 }, barIndex: 4 },
      ],
    });
    expect(s).toEqual({ bpmMin: 96, bpmMax: 130, meters: ["4/4", "7/8"], changes: 2 });
    expect(formatBpmRange(s)).toBe("96–130");
    expect(formatBpmRange({ ...s, bpmMax: 96 })).toBe("96");
  });
});

const three = { num: 3, den: 4 };

function norm(segments: TempoSegmentInput[]): TempoMap {
  const n = normalizeSegments(segments);
  if (!n.ok) throw new Error(n.issue.code);
  return { segments: n.segments };
}

function segs(head: HeadRow, rows: ChangeRow[]) {
  const r = mapFromRows(head, rows);
  if (!r.ok) throw new Error(r.error);
  return r.segments.map(({ startBeat, bpm, bpmEnd, meter, barIndex }) => ({
    startBeat,
    bpm,
    ...(bpmEnd !== undefined && { bpmEnd }),
    meter: `${meter.num}/${meter.den}`,
    bar: barIndex + 1,
  }));
}

const row = (bar: number, patch: Partial<ChangeRow> = {}): ChangeRow => ({
  id: `r${bar}`,
  bar,
  beat: 1,
  bpm: null,
  meter: null,
  ...patch,
});

describe("bar-based change rows (SPEC §7.1, §7.3)", () => {
  it("round-trips constant, stepped, meter-change and MIDI-like maps", () => {
    const maps = [
      norm([{ startBeat: 0, bpm: 120, meter: four }]),
      norm([
        { startBeat: 0, bpm: 120, meter: four },
        { startBeat: 16, bpm: 140, meter: four },
        { startBeat: 32, bpm: 90, meter: four },
      ]),
      norm([
        { startBeat: 0, bpm: 120, meter: four },
        { startBeat: 8, bpm: 120, meter: three },
        { startBeat: 14, bpm: 150, meter: three },
        { startBeat: 20, bpm: 150, meter: { num: 6, den: 8 } },
      ]),
      // Ramps (head too), an off-bar tempo change, a meter change during a ramp's target.
      norm([
        { startBeat: 0, bpm: 100, bpmEnd: 110, meter: four },
        { startBeat: 4, bpm: 110, meter: four },
        { startBeat: 6.5, bpm: 112, bpmEnd: 130, meter: four },
        { startBeat: 12, bpm: 112, meter: { num: 7, den: 8 } },
        { startBeat: 16, bpm: 96, meter: { num: 7, den: 8 } },
      ]),
    ];
    for (const m of maps) {
      const { head, rows } = rowsFromMap(m);
      const r = mapFromRows(head, rows);
      expect(r.ok && r.segments).toEqual(m.segments);
    }
    const midi = rowsFromMap(maps[3] as TempoMap);
    expect(midi.head).toEqual({ bpm: 100, meter: "4/4", bpmEnd: 110 });
    expect(midi.rows.map(({ bar, beat, bpm, meter }) => ({ bar, beat, bpm, meter }))).toEqual([
      { bar: 2, beat: 1, bpm: 110, meter: null },
      { bar: 2, beat: 3.5, bpm: 112, meter: null },
      { bar: 4, beat: 1, bpm: 112, meter: "7/8" }, // after a ramp the tempo is explicit
      { bar: 5, beat: 2, bpm: 96, meter: null },
    ]);
  });

  it("skips segments that change nothing", () => {
    const m = norm([
      { startBeat: 0, bpm: 120, meter: four },
      { startBeat: 4, bpm: 120, meter: four },
    ]);
    expect(rowsFromMap(m).rows).toEqual([]);
  });

  it("keeps later changes on their bars when an earlier time signature changes", () => {
    const rows = [row(3, { meter: "3/4" }), row(9, { bpm: 140 })];
    expect(segs({ bpm: 120, meter: "4/4" }, rows)).toEqual([
      { startBeat: 0, bpm: 120, meter: "4/4", bar: 1 },
      { startBeat: 8, bpm: 120, meter: "3/4", bar: 3 },
      { startBeat: 26, bpm: 140, meter: "3/4", bar: 9 },
    ]);
    // Bar 1 in 3/4: the bar-3 and bar-9 changes stay on bars 3 and 9.
    expect(segs({ bpm: 120, meter: "3/4" }, rows).map((s) => [s.bar, s.startBeat])).toEqual([
      [1, 0],
      [3, 6],
      [9, 24],
    ]);
    // Deleting the time signature change: bar 9 is recomputed in 4/4.
    expect(segs({ bpm: 120, meter: "4/4" }, [row(9, { bpm: 140 })]).at(-1)).toMatchObject({
      bar: 9,
      startBeat: 32,
    });
    // Rows with neither aspect are ignored.
    expect(segs({ bpm: 120, meter: "4/4" }, [row(4)])).toHaveLength(1);
  });

  it("moves a change to another bar (rows need not be sorted)", () => {
    const rows = [row(9, { bpm: 140 }), row(4, { meter: "3/4" })];
    expect(segs({ bpm: 120, meter: "4/4" }, rows).map((s) => [s.bar, s.startBeat])).toEqual([
      [1, 0],
      [4, 12],
      [9, 27],
    ]);
  });

  it("places tempo changes on beats within the bar (compound meters count dotted beats)", () => {
    expect(segs({ bpm: 120, meter: "6/8" }, [row(2, { beat: 2, bpm: 90 })]).at(-1)).toMatchObject({
      startBeat: 4.5,
      bar: 2,
    });
  });

  it("rejects invalid rows", () => {
    const h: HeadRow = { bpm: 120, meter: "4/4" };
    const err = (head: HeadRow, rows: ChangeRow[]) => {
      const r = mapFromRows(head, rows);
      return r.ok ? null : [r.error, r.rowId];
    };
    expect(err({ bpm: "", meter: "4/4" }, [])).toEqual(["bpm", undefined]);
    expect(err({ bpm: 500, meter: "4/4" }, [])).toEqual(["bpm", undefined]);
    expect(err({ bpm: 120, meter: "4/3" }, [])).toEqual(["meter", undefined]);
    expect(err(h, [row(1, { bpm: 90 })])).toEqual(["bar", "r1"]);
    expect(err(h, [row(2, { bar: 2.5, bpm: 90 })])).toEqual(["bar", "r2"]);
    expect(err(h, [row(2, { bar: "", bpm: 90 })])).toEqual(["bar", "r2"]);
    expect(err(h, [row(2, { beat: 0, bpm: 90 })])).toEqual(["beat", "r2"]);
    expect(err(h, [row(2, { beat: 5, bpm: 90 })])).toEqual(["beat", "r2"]);
    expect(err(h, [row(2, { bpm: 10 })])).toEqual(["bpm", "r2"]);
    expect(err(h, [row(2, { meter: "x" })])).toEqual(["meter", "r2"]);
    expect(err(h, [row(2, { beat: 2, bpm: 90, meter: "3/4" })])).toEqual(["meterOffBeat", "r2"]);
    expect(err(h, [row(2, { bpm: 90 }), { ...row(2, { meter: "3/4" }), id: "x" }])).toEqual([
      "duplicate",
      "x",
    ]);
  });

  it("drops a ramp when the change after it is deleted", () => {
    const m = norm([
      { startBeat: 0, bpm: 100, meter: four },
      { startBeat: 4, bpm: 110, bpmEnd: 130, meter: four },
      { startBeat: 8, bpm: 130, meter: four },
    ]);
    const { head, rows } = rowsFromMap(m);
    expect(segs(head, rows.slice(0, 1))).toEqual([
      { startBeat: 0, bpm: 100, meter: "4/4", bar: 1 },
      { startBeat: 4, bpm: 110, meter: "4/4", bar: 2 },
    ]);
    // Head ramp without any change: dropped too.
    expect(segs({ bpm: 100, meter: "4/4", bpmEnd: 120 }, [])).toEqual([
      { startBeat: 0, bpm: 100, meter: "4/4", bar: 1 },
    ]);
    // A ramp on a row that no longer sets the tempo is dropped.
    const r = [row(2, { meter: "3/4", bpmEnd: 150 }), row(3, { bpm: 150 })];
    expect(segs({ bpm: 100, meter: "4/4" }, r)[1]).not.toHaveProperty("bpmEnd");
  });

  it("adds tempo and time signature changes prefilled with what is in effect", () => {
    const head: HeadRow = { bpm: 120, meter: "4/4" };
    const tempo = addChangeAtBar(head, [row(3, { meter: "3/4" })], 5, "tempo");
    expect(tempo?.map(({ bar, beat, bpm, meter }) => ({ bar, beat, bpm, meter }))).toEqual([
      { bar: 3, beat: 1, bpm: null, meter: "3/4" },
      { bar: 5, beat: 1, bpm: 120, meter: null },
    ]);
    const meter = addChangeAtBar(head, tempo ?? [], 2, "meter");
    expect(meter?.[0]).toMatchObject({ bar: 2, meter: "4/4", bpm: null });
    expect(meter?.map((r) => r.bar)).toEqual([2, 3, 5]);
    // A row already at that bar gets the other aspect switched on (merge).
    const merged = addChangeAtBar(head, tempo ?? [], 5, "meter");
    expect(merged).toHaveLength(2);
    expect(merged?.[1]).toMatchObject({ bar: 5, bpm: 120, meter: "3/4" });
    expect(addChangeAtBar(head, tempo ?? [], 3, "tempo")?.[0]).toMatchObject({
      bpm: 120,
      meter: "3/4",
    });
    // A tempo change later in the same bar stays after the new row.
    const mid = addChangeAtBar(head, [row(4, { beat: 3, bpm: 90 })], 4, "meter");
    expect(mid?.map(({ bar, beat }) => [bar, beat])).toEqual([
      [4, 1],
      [4, 3],
    ]);
    // Already has that aspect, bar 1 or not a whole bar, invalid rows: nothing to add.
    expect(addChangeAtBar(head, tempo ?? [], 5, "tempo")).toBeNull();
    expect(addChangeAtBar(head, [], 1, "tempo")).toBeNull();
    expect(addChangeAtBar(head, [], 2.5, "meter")).toBeNull();
    expect(addChangeAtBar({ bpm: "", meter: "4/4" }, [], 2, "tempo")).toBeNull();
    // Tempo in the middle of a ramp is rounded to 0.001 BPM.
    const ramp = addChangeAtBar(
      { bpm: 100, meter: "4/4", bpmEnd: 200 },
      [row(4, { bpm: 200 })],
      3,
      "tempo",
    );
    expect(ramp?.find((r) => r.bar === 3)?.bpm).toBeCloseTo(166.667, 3);
  });
});
