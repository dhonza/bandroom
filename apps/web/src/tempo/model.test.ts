import { describe, expect, it } from "vitest";
import {
  EDIT_SAMPLE_RATE,
  FOLLOW_ALL,
  normalizeSegments,
  remapTempoMap,
  type TempoMap,
  type TempoSegmentInput,
} from "@bandroom/shared";
import {
  addChangeAtBar,
  addTap,
  cutBarBeats,
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

describe("bars cut short by an edit (SPEC §24.4)", () => {
  // 120 BPM 4/4 (a quarter note is 0.5 s), 140 BPM from bar 9.
  const base: TempoMap = norm([
    { startBeat: 0, bpm: 120, meter: four },
    { startBeat: 32, bpm: 140, meter: four },
  ]);
  /** The map after the seconds `[s, e)` are cut out with the tempo following. */
  const cut = (map: TempoMap, s: number, e: number): TempoMap => {
    const step = {
      kind: "cut" as const,
      start: s * EDIT_SAMPLE_RATE,
      end: e * EDIT_SAMPLE_RATE,
      timeline: FOLLOW_ALL,
    };
    const t = remapTempoMap({ map, bar1OffsetSec: 0 }, [step]);
    if (!t) throw new Error("no tempo");
    return t.map;
  };
  // Bar 3 beat 3 to bar 4 beat 2 cut: bar 3 ends after 2.5 quarters, the rest of bar 4 follows.
  const remapped = cut(base, 5.25, 6.75);
  const cutRows = (r: ChangeRow[]) =>
    r.map(({ bar, beat, bpm, meter, cutBar }) => ({ bar, beat, bpm, meter, cutBar }));

  it("keeps new bars as rows and round-trips the remapped map", () => {
    expect(remapped.segments.map((s) => [s.startBeat, s.barIndex, s.newBar])).toEqual([
      [0, 0, undefined],
      [10.5, 3, true],
      [13, 4, true],
      [29, 8, undefined],
    ]);
    const { head, rows } = rowsFromMap(remapped);
    expect(cutRows(rows)).toEqual([
      { bar: 4, beat: 1, bpm: null, meter: null, cutBar: 2.5 },
      { bar: 5, beat: 1, bpm: null, meter: null, cutBar: 2.5 },
      { bar: 9, beat: 1, bpm: 140, meter: null, cutBar: undefined },
    ]);
    const r = mapFromRows(head, rows);
    expect(r.ok && r.segments).toEqual(remapped.segments);
    // A cut in a 3/4 bar with a ramp over the join and a meter change after it.
    const ramp = norm([
      { startBeat: 0, bpm: 100, bpmEnd: 160, meter: three },
      { startBeat: 24, bpm: 160, meter: four },
    ]);
    const m = cut(ramp, 2, 3);
    expect(m.segments.some((s) => s.newBar)).toBe(true);
    const back = rowsFromMap(m);
    const r2 = mapFromRows(back.head, back.rows);
    expect(r2.ok && r2.segments).toEqual(m.segments);
  });

  it("drops a new bar that lies on the bar grid (it changes nothing)", () => {
    // Bar 3 to bar 4 beat 2 cut: the join is on a bar line, only the bar after it is cut short.
    const m = cut(base, 4, 6.75);
    expect(m.segments.map((s) => [s.startBeat, s.newBar])).toEqual([
      [0, undefined],
      [8, true],
      [10.5, true],
      [26.5, undefined],
    ]);
    const { head, rows } = rowsFromMap(m);
    expect(cutRows(rows)).toEqual([
      { bar: 4, beat: 1, bpm: null, meter: null, cutBar: 2.5 },
      { bar: 8, beat: 1, bpm: 140, meter: null, cutBar: undefined },
    ]);
    expect(segs(head, rows).map((s) => [s.startBeat, s.bar])).toEqual([
      [0, 1],
      [10.5, 4],
      [26.5, 8],
    ]);
  });

  it("keeps the cut and later bars when earlier changes are edited", () => {
    const { rows } = rowsFromMap(remapped);
    const edited = [row(2, { bpm: 90 }), row(3, { beat: 2, bpm: 100 }), ...rows];
    expect(
      segs({ bpm: 110, meter: "4/4" }, edited).map((s) => [s.startBeat, s.bar, s.bpm]),
    ).toEqual([
      [0, 1, 110],
      [4, 2, 90],
      [9, 3, 100],
      [10.5, 4, 100],
      [13, 5, 100],
      [29, 9, 140],
    ]);
    const r = mapFromRows({ bpm: 120, meter: "4/4" }, rows);
    expect(r.ok && r.segments.filter((s) => s.newBar).map((s) => s.startBeat)).toEqual([10.5, 13]);
    // A time signature on the cut row itself starts there.
    const sig = rows.map((x) => (x.bar === 5 ? { ...x, meter: "3/4" } : x));
    expect(segs({ bpm: 120, meter: "4/4" }, sig).map((s) => [s.startBeat, s.bar, s.meter])).toEqual(
      [
        [0, 1, "4/4"],
        [10.5, 4, "4/4"],
        [13, 5, "3/4"],
        [25, 9, "3/4"],
      ],
    );
  });

  it("adds changes after the cut on the right beats", () => {
    const { head, rows } = rowsFromMap(remapped);
    const added = addChangeAtBar(head, rows, 7, "tempo");
    expect(added?.find((x) => x.bar === 7)).toMatchObject({ beat: 1, bpm: 120, meter: null });
    expect(segs(head, added ?? []).find((s) => s.bar === 7)?.startBeat).toBe(21);
    const sig = addChangeAtBar(head, rows, 10, "meter");
    expect(sig?.find((x) => x.bar === 10)?.meter).toBe("4/4");
    expect(segs(head, sig ?? []).at(-1)).toMatchObject({ startBeat: 33, bar: 10 });
    // On the cut row itself: the aspect is switched on and the cut kept.
    const on = addChangeAtBar(head, rows, 5, "tempo");
    expect(on?.find((x) => x.bar === 5)).toMatchObject({ bpm: 120, cutBar: 2.5 });
  });

  it("counts the cut-short bar in beats of the time signature in effect", () => {
    const h: HeadRow = { bpm: 120, meter: "4/4" };
    const c = row(5, { cutBar: 1.5 });
    expect(cutBarBeats(h, [c], c)).toEqual({ beats: 1.5, of: 4 });
    expect(cutBarBeats({ bpm: 120, meter: "6/8" }, [c], c)).toEqual({ beats: 1, of: 2 });
    // The last time signature before the cut-short bar counts (rows need not be sorted).
    const rows = [row(4, { meter: "3/4" }), c, row(2, { meter: "7/8" }), row(5, { meter: "2/4" })];
    expect(cutBarBeats(h, rows, c)).toEqual({ beats: 1.5, of: 3 });
    expect(cutBarBeats({ bpm: 120, meter: "x" }, [c], c)).toBeNull();
    expect(cutBarBeats(h, [row(3)], row(3))).toBeNull();
  });

  it("rejects cut rows that no longer fit", () => {
    const err = (head: HeadRow, rows: ChangeRow[]) => {
      const r = mapFromRows(head, rows);
      return r.ok ? null : [r.error, r.rowId];
    };
    const h: HeadRow = { bpm: 120, meter: "4/4" };
    expect(err(h, [row(4, { cutBar: 2.5 })])).toBeNull();
    expect(err(h, [row(4, { beat: 2, cutBar: 2.5 })])).toEqual(["beat", "r4"]);
    expect(err(h, [row(4, { cutBar: 0 })])).toEqual(["cutBar", "r4"]);
    expect(err(h, [row(4, { cutBar: 4 })])).toEqual(["cutBar", "r4"]);
    // The time signature before it changed: 3.5 quarters do not fit a 3/4 bar.
    expect(err({ bpm: 120, meter: "3/4" }, [row(4, { cutBar: 3.5 })])).toEqual(["cutBar", "r4"]);
    // A change in the cut-short bar must lie before the cut.
    expect(err(h, [row(3, { beat: 4, bpm: 90 }), row(4, { cutBar: 2.5 })])).toEqual(["beat", "r3"]);
    expect(err(h, [row(3, { beat: 2, bpm: 90 }), row(4, { cutBar: 2.5 })])).toBeNull();
  });
});
