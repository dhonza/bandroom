import { describe, expect, it } from "vitest";
import { canonicalClips, clampFades, initialClip, maxOverlap } from "./clips";
import { canRedo, canUndo, foldOps, pushOp, redo, undo, type EditHistory } from "./history";
import {
  editedTracks,
  initialState,
  replay,
  songEndFrame,
  validateOp,
  type EditState,
} from "./ops";
import { remapSteps } from "./remap";
import {
  EditBaseSchema,
  EditOpSchema,
  FOLLOW_ALL,
  MAX_EDIT_OPS,
  type EditBase,
  type EditClip,
  type EditFades,
  type EditOp,
} from "./schema";

// ——— fixtures ————————————————————————————————————————————————————————————————————————————

let seq = 0;
const uuid = () => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}`;
const common = () => ({ id: uuid(), at: 1, userId: "u1", timeline: FOLLOW_ALL });
const F: EditFades = { fadeIn: 8, fadeOut: 6, crossfade: 20 };
const HARD: EditFades = { fadeIn: 0, fadeOut: 0, crossfade: 0 };

/** A clip of version `v` (source aligned with the timeline unless `src` is given). */
function clip(id: string, start: number, length: number, more: Partial<EditClip> = {}): EditClip {
  return {
    id,
    sourceVersionId: "v1",
    sourceStartFrame: start,
    startFrame: start,
    lengthFrames: length,
    gainDb: 0,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    fadeInShape: "equalPower",
    fadeOutShape: "equalPower",
    ...more,
  };
}

/** Tracks "a", "b", … with versions v1, v2, … of 1000 frames; `folded` clips replace the start. */
function base(...tracks: (EditClip[] | null)[]): EditBase {
  return {
    tracks: tracks.map((folded, i) => {
      const t = {
        trackId: String.fromCharCode(97 + i),
        versionId: `v${i + 1}`,
        offsetSamples: 0,
        gainDb: 0,
        lengthFrames: 1000,
      };
      return { ...t, clip: initialClip(t), ...(folded && { folded }) };
    }),
    remap: [],
    foldedOps: 0,
  };
}

const clipsOf = (s: EditState, track = "a") =>
  s.tracks.find((t) => t.trackId === track)?.clips ?? [];
const brief = (cs: readonly EditClip[]) =>
  cs.map((c) => [
    c.startFrame,
    c.lengthFrames,
    c.sourceStartFrame,
    c.fadeInFrames,
    c.fadeOutFrames,
  ]);

const split = (frames: number[], tracks = ["a"]): EditOp => ({
  type: "split",
  frames,
  tracks,
  ...common(),
});
const cut = (start: number, end: number, tracks = ["a"], fades = F): EditOp => ({
  type: "cut",
  range: { start, end },
  tracks,
  fades,
  ...common(),
});
const silence = (start: number, end: number, tracks = ["a"], fades = F): EditOp => ({
  type: "silence",
  range: { start, end },
  tracks,
  fades,
  ...common(),
});
const gain = (start: number, end: number, gainDb: number, fades = F): EditOp => ({
  type: "gain",
  range: { start, end },
  tracks: ["a"],
  gainDb,
  fades,
  ...common(),
});
const move = (
  clipIds: string[],
  deltaFrames: number,
  overlap: "mix" | "overwrite" | "block" = "mix",
  toTrackId: string | null = null,
  fades = F,
): EditOp => ({ type: "move", clipIds, deltaFrames, toTrackId, overlap, fades, ...common() });
const trim = (
  clipId: string,
  edge: "start" | "end",
  deltaFrames: number,
  overlap: "mix" | "overwrite" | "block" = "mix",
): EditOp => ({ type: "trim", clipId, edge, deltaFrames, overlap, fades: F, ...common() });

const run = (b: EditBase, ...ops: EditOp[]) => replay(b, ops);

// ——— tests ———————————————————————————————————————————————————————————————————————————————

describe("edit schemas (SPEC §24.2)", () => {
  it("parse ops and bases with their defaults", () => {
    const op = EditOpSchema.parse({ ...cut(0, 10), fades: {} });
    expect(op.type === "cut" && op.fades).toEqual({ fadeIn: 480, fadeOut: 480, crossfade: 480 });
    expect(EditOpSchema.safeParse({ ...cut(0, 10), range: { start: 5, end: 5 } }).success).toBe(
      false,
    );
    const b = EditBaseSchema.parse({ tracks: base(null).tracks });
    expect(b.remap).toEqual([]);
    expect(b.foldedOps).toBe(0);
  });
});

describe("clips", () => {
  it("start from the current version at its offset with the version gain", () => {
    const t = { trackId: "t", versionId: "v", offsetSamples: 100, gainDb: -3, lengthFrames: 50 };
    expect(initialClip(t)).toMatchObject({
      startFrame: 100,
      sourceStartFrame: 0,
      lengthFrames: 50,
    });
    expect(initialClip({ ...t, offsetSamples: -20, gainDb: 99 })).toMatchObject({
      startFrame: 0,
      sourceStartFrame: 20,
      lengthFrames: 30,
      gainDb: 24,
    });
    expect(initialClip({ ...t, offsetSamples: -50 })).toBeNull();
    const empty = base(null);
    empty.tracks[0] = { ...(empty.tracks[0] as EditBase["tracks"][number]), clip: null };
    expect(initialState(empty).tracks[0]?.clips).toEqual([]);
  });

  it("clamp fades to half the clip and count overlaps", () => {
    expect(clampFades(clip("x", 0, 9, { fadeInFrames: 100, fadeOutFrames: 2 }))).toMatchObject({
      fadeInFrames: 4,
      fadeOutFrames: 2,
    });
    const c = clip("x", 0, 9);
    expect(clampFades(c)).toBe(c);
    expect(maxOverlap([clip("a", 0, 10), clip("b", 5, 10), clip("c", 10, 5)])).toBe(2);
    expect(maxOverlap([])).toBe(0);
  });
});

describe("split", () => {
  it("splits covering clips of the chosen tracks into seamless halves with derived ids", () => {
    const b = base(null, null);
    const op = split([400]);
    const s = run(b, op);
    expect(clipsOf(s).map((c) => c.id)).toEqual([`${op.id}:0`, `${op.id}:1`]);
    expect(brief(clipsOf(s))).toEqual([
      [0, 400, 0, 0, 0],
      [400, 600, 400, 0, 0],
    ]);
    expect(clipsOf(s, "b")).toHaveLength(1);
    // Split equivalence: the same audio, so nothing to apply.
    expect(canonicalClips(clipsOf(s))).toEqual(
      canonicalClips(b.tracks[0]?.clip ? [b.tracks[0].clip] : []),
    );
    expect(editedTracks(b, s)).toEqual([]);
  });

  it("keeps the outer fades and splits at two points (a selection)", () => {
    const b = base([clip("x", 0, 1000, { fadeInFrames: 5, fadeOutFrames: 7 })]);
    const s = run(b, split([600, 300, 600]));
    expect(brief(clipsOf(s))).toEqual([
      [0, 300, 0, 5, 0],
      [300, 300, 300, 0, 0],
      [600, 400, 600, 0, 7],
    ]);
  });

  it("does nothing at a clip edge, and splits at markers", () => {
    const b = base([clip("x", 0, 500), clip("y", 500, 500)]);
    const st = initialState(b);
    expect(validateOp(st, split([500]))).toBe("noChange");
    const s = run(b, {
      type: "splitAtMarkers",
      markerIds: ["m1", "m2"],
      frames: [250, 750],
      tracks: ["a"],
      ...common(),
    });
    expect(clipsOf(s)).toHaveLength(4);
  });
});

describe("cut", () => {
  it("removes a range across several clips and ripples with a centred crossfade", () => {
    const b = base(null);
    const s = run(b, split([300, 600]), cut(200, 700));
    // Head [0,200) reaches 10 frames into the cut audio, tail (700…) 10 frames back.
    expect(brief(clipsOf(s))).toEqual([
      [0, 210, 0, 0, 20],
      [190, 310, 690, 20, 0],
    ]);
    expect(songEndFrame(s)).toBe(500);
    expect(clipsOf(s).every((c) => c.fadeOutShape === "equalPower")).toBe(true);
  });

  it("ripples only the chosen tracks (subset)", () => {
    const s = run(base(null, null), cut(100, 200));
    expect(songEndFrame(s)).toBe(1000);
    expect(brief(clipsOf(s, "b"))).toEqual([[0, 1000, 0, 0, 0]]);
    expect(clipsOf(s)).toHaveLength(2);
  });

  it("fades in at the song start and out at the song end", () => {
    expect(brief(clipsOf(run(base(null), cut(0, 100))))).toEqual([[0, 900, 100, 8, 0]]);
    expect(brief(clipsOf(run(base(null), cut(900, 1000))))).toEqual([[0, 900, 0, 0, 6]]);
  });

  it("shifts later clips and keeps the joins of touching clips", () => {
    const b = base([clip("x", 0, 100), clip("y", 100, 100), clip("z", 500, 100)]);
    const s = run(b, cut(100, 200, ["a"], HARD));
    expect(brief(clipsOf(s))).toEqual([
      [0, 100, 0, 0, 0],
      [400, 100, 500, 0, 0],
    ]);
  });

  it("fades one-sided where a source has no audio beyond the join, a dip where neither has", () => {
    const end = { sourceVersionId: "v9" };
    // x ends at its source's end (v9 is unknown: no more audio), y starts at its source start.
    const b = base([clip("x", 0, 100, end), clip("y", 150, 100, { sourceStartFrame: 300 })]);
    expect(brief(clipsOf(run(b, cut(100, 150))))).toEqual([
      [0, 100, 0, 0, 10],
      [90, 110, 290, 10, 0],
    ]);
    const c = base([clip("x", 0, 100, end), clip("y", 150, 100, { sourceStartFrame: 0 })]);
    expect(brief(clipsOf(run(c, cut(100, 150))))).toEqual([
      [0, 100, 0, 0, 10],
      [100, 100, 0, 10, 0],
    ]);
  });
});

describe("silence", () => {
  it("removes audio in place with a fade out before and a fade in after the gap", () => {
    const s = run(base(null), silence(200, 300));
    expect(brief(clipsOf(s))).toEqual([
      [0, 200, 0, 0, 6],
      [300, 700, 300, 8, 0],
    ]);
  });

  it("at the song edges only fades the remaining side; a gap is no change", () => {
    expect(brief(clipsOf(run(base(null), silence(0, 100))))).toEqual([[100, 900, 100, 8, 0]]);
    expect(brief(clipsOf(run(base(null), silence(900, 1000))))).toEqual([[0, 900, 0, 0, 6]]);
    const b = base([clip("x", 0, 100), clip("y", 500, 100)]);
    expect(validateOp(initialState(b), silence(200, 300))).toBe("noChange");
    const s = run(b, silence(100, 500));
    expect(brief(clipsOf(s))).toEqual(brief(clipsOf(initialState(b))));
  });
});

describe("gain", () => {
  it("splits at the edges, sets the gain inside and ramps with linear crossfades", () => {
    const s = run(base(null), gain(200, 400, -6));
    const cs = clipsOf(s);
    expect(cs.map((c) => c.gainDb)).toEqual([0, -6, 0]);
    expect(brief(cs)).toEqual([
      [0, 210, 0, 0, 20],
      [190, 220, 190, 20, 20],
      [390, 610, 390, 20, 0],
    ]);
    expect(cs[0]?.fadeOutShape).toBe("linear");
    expect(cs[1]?.fadeInShape).toBe("linear");
    expect(cs[1]?.fadeOutShape).toBe("linear");
  });

  it("sets a whole clip without ramps; no crossfade means a hard step", () => {
    const whole = clipsOf(run(base(null), gain(0, 1000, 3)));
    expect(whole.map((c) => [c.gainDb, c.fadeInFrames, c.fadeOutFrames])).toEqual([[3, 0, 0]]);
    expect(brief(clipsOf(run(base(null), gain(200, 400, -6, HARD))))).toEqual([
      [0, 200, 0, 0, 0],
      [200, 200, 200, 0, 0],
      [400, 600, 400, 0, 0],
    ]);
  });

  it("does not ramp between unrelated audio", () => {
    const b = base([clip("x", 0, 100), clip("y", 100, 100, { sourceVersionId: "v2" })]);
    const cs = clipsOf(run(b, gain(100, 200, -6)));
    expect(brief(cs)).toEqual([
      [0, 100, 0, 0, 0],
      [100, 100, 100, 0, 0],
    ]);
    expect(cs.map((c) => c.gainDb)).toEqual([0, -6]);
  });
});

describe("move", () => {
  const two = () => base([clip("x", 0, 100), clip("y", 300, 100)], null);

  it("mix: both play, the overlapping edges get the crossfade", () => {
    const s = run(two(), move(["y"], -250));
    expect(brief(clipsOf(s))).toEqual([
      [0, 100, 0, 0, 20],
      [50, 100, 300, 20, 0],
    ]);
    // The moved clip covers x's end only from inside: a later one inside x gets both edges.
    const inner = run(base([clip("x", 0, 400), clip("y", 500, 100)]), move(["y"], -400));
    expect(brief(clipsOf(inner))).toEqual([
      [0, 400, 0, 0, 0],
      [100, 100, 500, 20, 20],
    ]);
    const outer = run(base([clip("x", 100, 50), clip("y", 500, 200)]), move(["y"], -450));
    expect(brief(clipsOf(outer))).toEqual([
      [50, 200, 500, 0, 0],
      [100, 50, 100, 20, 20],
    ]);
  });

  it("overwrite: the moved clip wins, covered parts go, edges crossfade", () => {
    const s = run(base([clip("x", 0, 400), clip("y", 500, 100)]), move(["y"], -400, "overwrite"));
    const cs = clipsOf(s);
    // x is split around y; each piece reaches 20 frames under y.
    expect(brief(cs)).toEqual([
      [0, 120, 0, 0, 20],
      [100, 100, 500, 20, 20],
      [180, 220, 180, 20, 0],
    ]);
    expect(cs.map((c) => c.id).filter((id) => id.includes(":"))).toHaveLength(2);
  });

  it("overwrite with a hard edge and a piece without more source", () => {
    const b = base([clip("x", 0, 100, { sourceVersionId: "v9" }), clip("y", 500, 100)]);
    const s = run(b, move(["y"], -450, "overwrite", null, HARD));
    expect(brief(clipsOf(s))).toEqual([
      [0, 50, 0, 0, 0],
      [50, 100, 500, 0, 0],
    ]);
  });

  it("block: the clip stops where it touches its neighbour", () => {
    const s = run(two(), move(["x"], 500, "block"));
    expect(brief(clipsOf(s))).toEqual([
      [200, 100, 0, 0, 0],
      [300, 100, 300, 0, 0],
    ]);
    const left = run(two(), move(["y"], -500, "block"));
    expect(brief(clipsOf(left))[1]).toEqual([100, 100, 300, 0, 0]);
    expect(brief(clipsOf(run(two(), move(["y"], 50, "block"))))[1]).toEqual([350, 100, 300, 0, 0]);
  });

  it("block across tracks: the free position closest to the target", () => {
    const b = base([clip("x", 0, 100)], [clip("q", 0, 300, { sourceVersionId: "v2" })]);
    const s = run(b, move(["x"], 50, "block", "b"));
    expect(clipsOf(s)).toEqual([]);
    expect(brief(clipsOf(s, "b"))).toEqual([
      [0, 300, 0, 0, 0],
      [300, 100, 0, 0, 0],
    ]);
    const touching = initialState(base([clip("x", 0, 100), clip("y", 100, 100)]));
    expect(validateOp(touching, move(["y"], -50, "block"))).toBe("noChange");
  });

  it("moves to another track, keeps its source and gain, clamps at 0", () => {
    const b = base(
      [clip("x", 100, 100, { gainDb: -4 })],
      [clip("q", 500, 100, { sourceVersionId: "v2" })],
    );
    const s = run(b, move(["x"], -1000, "mix", "b"));
    expect(clipsOf(s)).toEqual([]);
    expect(clipsOf(s, "b")[0]).toMatchObject({
      id: "x",
      startFrame: 0,
      sourceVersionId: "v1",
      gainDb: -4,
    });
    expect(run(b, move(["nope"], 10))).toEqual({ ...initialState(b), ops: 1 });
  });
});

describe("trim", () => {
  const b = () => base([clip("x", 100, 100), clip("y", 300, 100)]);

  it("shortens either edge (silence remains) and keeps at least one frame", () => {
    expect(brief(clipsOf(run(b(), trim("x", "start", 30))))[0]).toEqual([130, 70, 130, 0, 0]);
    expect(brief(clipsOf(run(b(), trim("x", "end", -30))))[0]).toEqual([100, 70, 100, 0, 0]);
    expect(brief(clipsOf(run(b(), trim("x", "end", -500))))[0]).toEqual([100, 1, 100, 0, 0]);
    expect(brief(clipsOf(run(b(), trim("x", "start", 500))))[0]).toEqual([199, 1, 199, 0, 0]);
    expect(run(b(), trim("nope", "start", 5))).toEqual({ ...initialState(b()), ops: 1 });
  });

  it("lengthens up to the source's ends", () => {
    expect(brief(clipsOf(run(b(), trim("x", "start", -500))))[0]).toEqual([0, 200, 0, 0, 0]);
    const s = run(b(), trim("y", "end", 5000));
    expect(brief(clipsOf(s)).at(-1)).toEqual([300, 700, 300, 0, 0]);
  });

  it("lengthening follows the overlap mode", () => {
    expect(brief(clipsOf(run(b(), trim("x", "end", 150, "block"))))[0]).toEqual([
      100, 200, 100, 0, 0,
    ]);
    expect(brief(clipsOf(run(b(), trim("y", "start", -150, "block"))))[1]).toEqual([
      200, 200, 200, 0, 0,
    ]);
    expect(brief(clipsOf(run(b(), trim("x", "end", 150, "mix"))))).toEqual([
      [100, 250, 100, 0, 20],
      [300, 100, 300, 20, 0],
    ]);
    expect(brief(clipsOf(run(b(), trim("x", "end", 150, "overwrite"))))).toEqual([
      [100, 250, 100, 0, 20],
      [330, 70, 330, 20, 0],
    ]);
    expect(brief(clipsOf(run(b(), trim("y", "start", -150, "overwrite"))))).toEqual([
      [100, 70, 100, 0, 20],
      [150, 250, 150, 20, 0],
    ]);
  });
});

describe("fades", () => {
  it("clamp to half the clip", () => {
    const s = run(base([clip("x", 0, 20), clip("y", 100, 900)]), silence(10, 15));
    expect(brief(clipsOf(s)).slice(0, 2)).toEqual([
      [0, 10, 0, 0, 5],
      [15, 5, 15, 2, 0],
    ]);
  });
});

describe("replay, undo, redo, folding", () => {
  const ops = () => [split([500]), cut(100, 200), gain(300, 400, -3), silence(600, 700)];

  it("replays deterministically; undo/redo move the cursor; a new op drops the redo tail", () => {
    const b = base(null, null);
    const list = ops();
    expect(replay(b, list)).toEqual(replay(b, list));
    let h: EditHistory = { ops: [], cursor: 0 };
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h);
    for (const op of list) h = pushOp(h, op);
    expect(canRedo(h)).toBe(false);
    expect(redo(h)).toBe(h);
    h = undo(undo(h));
    expect(h.cursor).toBe(2);
    expect(replay(b, h.ops, h.cursor)).toEqual(replay(b, list.slice(0, 2)));
    expect(redo(h).cursor).toBe(3);
    const extra = split([50]);
    h = pushOp(h, extra);
    expect(h.ops).toEqual([...list.slice(0, 2), extra]);
    expect(h.cursor).toBe(3);
  });

  it("folds the oldest applied ops into the base without changing the result", () => {
    const b = base(null, null);
    const all = [cut(100, 200, ["a", "b"]), ...ops()];
    const h = { ops: all, cursor: 4 };
    const f = foldOps(b, h, 2);
    expect(f.ops).toEqual(all.slice(3));
    expect(f.cursor).toBe(1);
    expect(f.base.foldedOps).toBe(3);
    expect(f.base.remap).toHaveLength(1);
    expect(replay(f.base, f.ops, f.cursor).tracks).toEqual(replay(b, all, 4).tracks);
    expect(remapSteps(f.base, f.ops, f.cursor)).toEqual(remapSteps(b, all, 4));
    expect(editedTracks(f.base, replay(f.base, f.ops, f.cursor))).toEqual(["a", "b"]);
    // Undone ops are never folded; nothing to fold leaves everything as is.
    expect(foldOps(b, { ops: all, cursor: 0 }, 0).base).toBe(b);
    expect(EditBaseSchema.parse(f.base)).toEqual(f.base);
  });
});

describe("validation", () => {
  const st = () => initialState(base(null, null));

  it("accepts a valid op and refuses with a reason", () => {
    expect(validateOp(st(), cut(100, 200))).toBeNull();
    expect(validateOp({ ...st(), ops: MAX_EDIT_OPS }, cut(100, 200))).toBe("tooManyOps");
    expect(validateOp(st(), cut(100, 200, ["zz"]))).toBe("unknownTrack");
    expect(validateOp(st(), move(["a:base"], 5, "mix", "zz"))).toBe("unknownTrack");
    expect(validateOp(st(), move(["nope"], 5))).toBe("unknownClip");
    expect(validateOp(st(), trim("nope", "end", 5))).toBe("unknownClip");
    expect(validateOp(st(), trim("a:base", "start", 5))).toBeNull();
    expect(validateOp(st(), cut(100, 2000))).toBe("outsideSong");
    expect(validateOp(st(), split([0]))).toBe("outsideSong");
    expect(validateOp(st(), split([1000]))).toBe("outsideSong");
  });

  it("limits clips per track and overlapping clips", () => {
    const many = Array.from({ length: 500 }, (_, i) => clip(`c${i}`, i * 2, 2));
    expect(validateOp(initialState(base(many)), split([1]))).toBe("tooManyClips");
    const stack = Array.from({ length: 4 }, (_, i) => clip(`s${i}`, 0, 100));
    const s = initialState(base([...stack, clip("x", 200, 100)]));
    expect(validateOp(s, move(["x"], -150))).toBe("tooManyOverlaps");
  });
});

describe("edited tracks", () => {
  it("lists the tracks that play differently from the start", () => {
    const b = base(null, null);
    expect(editedTracks(b, run(b, silence(0, 10, ["b"])))).toEqual(["b"]);
    expect(editedTracks(b, { ...initialState(b), tracks: [] })).toEqual(["a", "b"]);
  });
});
