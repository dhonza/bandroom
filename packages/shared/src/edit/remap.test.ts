import { describe, expect, it } from "vitest";
import { beatToSec, compileTempo } from "../tempo/math";
import type { Meter, Tempo, TempoSegmentInput } from "../tempo/model";
import { initialClip } from "./clips";
import {
  cutTempo,
  remapComments,
  remapMarkers,
  remapSteps,
  remapTempoMap,
  type RemappableComment,
  type RemappableMarker,
} from "./remap";
import { FOLLOW_ALL, type EditBase, type EditOp, type RemapStep } from "./schema";
import {
  cutTimeMap,
  mapTime,
  mapTimeRange,
  moveTimeMap,
  scaleTimeMap,
  shiftTimeMap,
} from "./timeMap";

const SR = 48_000;
let seq = 0;
const common = () => ({
  id: `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}`,
  at: 1,
  userId: "u1",
  timeline: FOLLOW_ALL,
});
const fades = { fadeIn: 0, fadeOut: 0, crossfade: 0 };
const m44: Meter = { num: 4, den: 4 };
const m34: Meter = { num: 3, den: 4 };

function base(n = 2): EditBase {
  return {
    tracks: Array.from({ length: n }, (_, i) => {
      const t = {
        trackId: `t${i}`,
        versionId: `v${i}`,
        offsetSamples: 0,
        gainDb: 0,
        lengthFrames: 1000,
      };
      return { ...t, clip: initialClip(t) };
    }),
    remap: [],
    foldedOps: 0,
  };
}

const cutStep = (startSec: number, endSec: number, timeline = FOLLOW_ALL): RemapStep => ({
  kind: "cut",
  start: startSec * SR,
  end: endSec * SR,
  timeline,
});

const tempo = (segments: TempoSegmentInput[], bar1OffsetSec = 0): Tempo => ({
  map: { segments: segments.map((s) => ({ barIndex: 0, ...s })) },
  bar1OffsetSec,
});
const t120 = (offset = 0) => tempo([{ startBeat: 0, bpm: 120, meter: m44 }], offset);

describe("time maps (SPEC §24.4)", () => {
  it("map points: shifts clamp at 0, cut edges meet at the join, the inside is deleted", () => {
    expect(mapTime(shiftTimeMap(-5), 3)).toBe(0);
    expect(mapTime(shiftTimeMap(-5), 3, false)).toBe(-2);
    const cut = cutTimeMap(10, 20);
    expect([5, 10, 15, 20, 25].map((t) => mapTime(cut, t))).toEqual([5, 10, null, 10, 15]);
    expect(mapTime(scaleTimeMap(cut, 0.5), 10)).toBe(5);
    const mv = moveTimeMap(10, 20, 100);
    expect([5, 10, 19, 20].map((t) => mapTime(mv, t))).toEqual([5, 110, 119, 20]);
  });

  it("map ranges: edges in deleted time move inwards; nothing left means deleted", () => {
    const cut = cutTimeMap(10, 20);
    expect(mapTimeRange(cut, 0, 30)).toEqual({ start: 0, end: 20 });
    expect(mapTimeRange(cut, 15, 30)).toEqual({ start: 10, end: 20 });
    expect(mapTimeRange(cut, 5, 15)).toEqual({ start: 5, end: 10 });
    expect(mapTimeRange(cut, 12, 18)).toBeNull();
    expect(mapTimeRange(cut, 10, 20)).toBeNull();
    expect(mapTimeRange(moveTimeMap(10, 20, -50), 5, 15)).toEqual({ start: 0, end: 5 });
    expect(mapTimeRange(moveTimeMap(10, 20, 50), 15, 25)).toEqual({ start: 25, end: 65 });
  });
});

describe("timeline steps", () => {
  it("come from cuts and same-range moves on all tracks only", () => {
    const b = base();
    const sp: EditOp = { type: "split", frames: [200, 400], tracks: ["t0", "t1"], ...common() };
    const id = (n: number) => `${sp.id}:${n}`;
    const op = (o: Record<string, unknown>) => ({ ...common(), fades, ...o }) as EditOp;
    const cutAll = op({ type: "cut", range: { start: 0, end: 10 }, tracks: ["t0", "t1"] });
    const cutOne = op({ type: "cut", range: { start: 0, end: 10 }, tracks: ["t0"] });
    const quiet = op({ type: "silence", range: { start: 0, end: 10 }, tracks: ["t0", "t1"] });
    const mv = (clipIds: string[], deltaFrames: number, toTrackId: string | null = null) =>
      op({ type: "move", clipIds, deltaFrames, toTrackId, overlap: "mix" });
    const steps = (...ops: EditOp[]) => remapSteps(b, [sp, ...ops]);
    expect(steps(cutAll)).toEqual([{ kind: "cut", start: 0, end: 10, timeline: FOLLOW_ALL }]);
    expect(steps(cutOne, quiet)).toEqual([]);
    expect(steps(mv([id(2), id(6)], 50))).toEqual([
      { kind: "move", start: 200, end: 400, delta: 50, timeline: FOLLOW_ALL },
    ]);
    expect(steps(mv([id(2)], 50))).toEqual([]);
    expect(steps(mv([id(2), id(4)], 50))).toEqual([]);
    expect(steps(mv([id(2), id(6)], 0))).toEqual([]);
    expect(steps(mv([id(2), id(6)], 50, "t1"))).toEqual([]);
    expect(remapSteps({ ...b, remap: [cutStep(0, 1)] }, [cutAll], 0)).toEqual([cutStep(0, 1)]);
  });
});

describe("tempo map follow-up", () => {
  const segs = (t: Tempo) => t.map.segments;

  it("moves bar 1 when the cut lies before it", () => {
    const t = cutTempo(t120(2), 0.5, 1.5);
    expect(t.bar1OffsetSec).toBe(1);
    expect(t.map).toEqual(t120(2).map);
  });

  it("joins on bar lines with a plain segment (a meter change there is fine)", () => {
    expect(segs(cutTempo(t120(), 2, 4))).toEqual([
      { startBeat: 0, bpm: 120, meter: m44, barIndex: 0 },
      { startBeat: 4, bpm: 120, meter: m44, barIndex: 1 },
    ]);
    const meter = tempo([
      { startBeat: 0, bpm: 120, meter: m44 },
      { startBeat: 8, bpm: 120, meter: m34 },
    ]);
    expect(segs(cutTempo(meter, 2, 4))).toEqual([
      { startBeat: 0, bpm: 120, meter: m44, barIndex: 0 },
      { startBeat: 4, bpm: 120, meter: m34, barIndex: 1 },
    ]);
  });

  it("starts a new bar at an off-bar join and at the next downbeat, the index continuing", () => {
    const t = cutTempo(t120(), 1.25, 2.75);
    expect(segs(t)).toEqual([
      { startBeat: 0, bpm: 120, meter: m44, barIndex: 0 },
      { startBeat: 2.5, bpm: 120, meter: m44, barIndex: 1, newBar: true },
      { startBeat: 5, bpm: 120, meter: m44, barIndex: 2, newBar: true },
    ]);
    // The old bar 3 downbeat (4 s) is 1.5 s earlier and still a downbeat.
    const g = compileTempo(t);
    expect(beatToSec(g, 5)).toBeCloseTo(2.5, 9);
    // A second cut inside the new regions finds the next region start before the bar end.
    expect(segs(cutTempo(t, 0.5, 1.5)).map((s) => [s.startBeat, s.barIndex, s.newBar])).toEqual([
      [0, 0, undefined],
      [1, 1, true],
      [3, 2, true],
    ]);
  });

  it("drops segments inside the cut and continues with the tempo after it", () => {
    const t = tempo([
      { startBeat: 0, bpm: 120, meter: m44 },
      { startBeat: 8, bpm: 60, meter: m44 },
      { startBeat: 12, bpm: 120, meter: m44 },
    ]);
    expect(segs(cutTempo(t, 3, 9))).toEqual([
      { startBeat: 0, bpm: 120, meter: m44, barIndex: 0 },
      { startBeat: 6, bpm: 120, meter: m44, barIndex: 2, newBar: true },
      { startBeat: 8, bpm: 120, meter: m44, barIndex: 3, newBar: true },
    ]);
  });

  it("puts bar 1 at the join when the cut spans it", () => {
    const t = cutTempo(t120(1), 0.5, 2);
    expect(t.bar1OffsetSec).toBe(0.5);
    expect(segs(t)).toEqual([
      { startBeat: 0, bpm: 120, meter: m44, barIndex: 0 },
      { startBeat: 2, bpm: 120, meter: m44, barIndex: 1, newBar: true },
    ]);
  });

  it("splits ramps exactly", () => {
    const ramp = tempo([
      { startBeat: 0, bpm: 100, bpmEnd: 140, meter: m44 },
      { startBeat: 8, bpm: 140, meter: m44 },
    ]);
    const g = compileTempo(ramp);
    const t = cutTempo(ramp, beatToSec(g, 2), beatToSec(g, 5));
    const s = segs(t);
    expect(s.map((x) => x.startBeat).map((b) => Math.round(b * 1e6) / 1e6)).toEqual([0, 2, 5]);
    expect(s[0]?.bpmEnd).toBeCloseTo(110, 6);
    expect(s[1]?.bpm).toBeCloseTo(125, 6);
    expect(s[1]?.bpmEnd).toBe(140);
    expect(s[2]).toMatchObject({ bpm: 140, newBar: true });

    const long = tempo([
      { startBeat: 0, bpm: 100, bpmEnd: 140, meter: m44 },
      { startBeat: 12, bpm: 140, meter: m44 },
    ]);
    const gl = compileTempo(long);
    const l = segs(cutTempo(long, beatToSec(gl, 2), beatToSec(gl, 5)));
    expect(l.map((x) => Math.round(x.startBeat * 1e6) / 1e6)).toEqual([0, 2, 5, 9]);
    expect(l[1]?.bpmEnd).toBeCloseTo(100 + (40 / 12) * 8, 6);
    expect(l[2]).toMatchObject({ bpmEnd: 140, newBar: true });
    expect(l[2]?.bpm).toBeCloseTo(100 + (40 / 12) * 8, 6);

    // A ramp that ends at the join keeps its target.
    const atJoin = tempo([
      { startBeat: 0, bpm: 100, bpmEnd: 140, meter: m44 },
      { startBeat: 4, bpm: 140, meter: m44 },
    ]);
    const ga = compileTempo(atJoin);
    expect(segs(cutTempo(atJoin, beatToSec(ga, 4), beatToSec(ga, 8)))[0]?.bpmEnd).toBe(140);
  });

  it("follows only the steps with the tempo switch on; moves leave it", () => {
    const off = { ...FOLLOW_ALL, tempo: false };
    expect(remapTempoMap(null, [cutStep(1, 2)])).toBeNull();
    expect(remapTempoMap(t120(2), [cutStep(0, 1, off)])).toEqual(t120(2));
    expect(remapTempoMap(t120(2), [cutStep(0, 1)])?.bar1OffsetSec).toBe(1);
    const mv: RemapStep = { kind: "move", start: 0, end: SR, delta: SR, timeline: FOLLOW_ALL };
    expect(remapTempoMap(t120(2), [mv])).toEqual(t120(2));
  });
});

describe("markers and sections follow-up", () => {
  const item = (
    id: string,
    startSec: number,
    endSec: number | null = null,
    more: Partial<RemappableMarker> = {},
  ): RemappableMarker => ({
    id,
    type: endSec === null ? "marker" : "section",
    startSec,
    endSec,
    anchor: "time",
    startBeat: null,
    endBeat: null,
    ...more,
  });

  it("maps markers, deletes those cut away, shrinks sections; musical items keep the music", () => {
    const items = [
      item("m1", 1),
      item("m2", 2),
      item("m3", 3, null, { anchor: "musical", startBeat: 6 }),
      item("s1", 1, 2),
      item("s2", 1.5, 2.5),
      item("s3", 2, 4, { anchor: "musical", startBeat: 4, endBeat: 8 }),
    ];
    const r = remapMarkers(items, [cutStep(1.25, 2.75)], t120());
    expect(r.deleted).toEqual(["m2", "s2"]);
    expect(r.moved).toEqual(["m3", "s1", "s3"]);
    expect(r.items.map((m) => [m.id, m.startSec, m.endSec, m.startBeat, m.endBeat])).toEqual([
      ["m1", 1, null, null, null],
      ["m3", 1.5, null, 3, null],
      ["s1", 1, 1.25, null, null],
      ["s3", 1.25, 2.5, 2.5, 5],
    ]);
  });

  it("leaves kinds whose switch is off (musical beats still follow a remapped tempo map)", () => {
    const items = [
      item("m", 3, null, { anchor: "musical", startBeat: 6 }),
      item("s", 2, 4),
      item("t", 3),
    ];
    const markersOff = { ...FOLLOW_ALL, markers: false };
    const r = remapMarkers(items, [cutStep(0, 1, markersOff)], t120(2));
    expect(r.items.map((m) => [m.id, m.startSec, m.startBeat])).toEqual([
      ["m", 3, 4],
      ["s", 1, null],
      ["t", 3, null],
    ]);
    const none = { markers: false, sections: false, comments: true, tempo: false };
    expect(remapMarkers(items, [cutStep(0, 1, none)], null).items).toEqual(items);
    // Moves of a range on all tracks carry the items in it.
    const mv: RemapStep = {
      kind: "move",
      start: 2 * SR,
      end: 3.5 * SR,
      delta: SR,
      timeline: FOLLOW_ALL,
    };
    expect(remapMarkers([item("t", 3)], [mv], null).items[0]?.startSec).toBe(4);
  });
});

describe("comments follow-up", () => {
  const c = (
    id: string,
    startSec: number | null,
    endSec: number | null = null,
  ): RemappableComment => ({
    id,
    startSec,
    endSec,
    context: { trackVersions: { t: "v" }, tempoRev: null },
  });

  it("maps times; cut-away comments become general with a note of their old time", () => {
    const items = [c("p", 2), c("r", 1.5, 2.5), c("k", 1, 3), c("g", null), c("q", 3), c("s", 0.5)];
    const r = remapComments(items, [cutStep(1.25, 2.75), cutStep(0.1, 0.2)], "sess");
    expect(r.editedOut).toEqual(["p", "r"]);
    expect(r.moved).toEqual(["k", "q", "s"]);
    expect(r.items[0]).toEqual({
      ...c("p", null),
      context: {
        trackVersions: { t: "v" },
        tempoRev: null,
        editedOut: { startSec: 2, endSec: null, sessionId: "sess" },
      },
    });
    expect(r.items[1]?.context.editedOut).toEqual({
      startSec: 1.5,
      endSec: 2.5,
      sessionId: "sess",
    });
    expect(r.items[2]).toMatchObject({ startSec: 0.9, endSec: 1.4 });
    expect(r.items[3]).toEqual(c("g", null));
    const off = { ...FOLLOW_ALL, comments: false };
    expect(remapComments(items, [cutStep(1.25, 2.75, off)], "s").items).toEqual(items);
  });
});
