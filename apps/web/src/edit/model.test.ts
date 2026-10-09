import {
  DEFAULT_EDIT_FADES,
  FOLLOW_ALL,
  initialClip,
  replay,
  type EditBase,
  type EditClip,
  type EditOptions,
} from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import {
  clipBoxes,
  clipEdges,
  fadePath,
  moveFromDrag,
  moveOp,
  outOfSync,
  rangeOp,
  resolveEditKey,
  splitAtMarkersOp,
  splitFrames,
  splitOp,
  splitPoints,
  trimFromDrag,
  trimOp,
  unavailable,
  type EditTarget,
} from "./model";

const SR = 48_000;
const track = (id: string, seconds: number, offset = 0) => {
  const t = {
    trackId: id,
    versionId: `v-${id}`,
    offsetSamples: offset,
    gainDb: 0,
    lengthFrames: seconds * SR,
  };
  return { ...t, clip: initialClip(t) };
};
const base: EditBase = {
  tracks: [track("a", 10), track("b", 10), track("c", 8, SR)],
  remap: [],
  foldedOps: 0,
};
const options: EditOptions = {
  fades: DEFAULT_EDIT_FADES,
  overlap: "mix",
  timeline: FOLLOW_ALL,
  snap: "markers",
};
const target = (patch: Partial<EditTarget> = {}): EditTarget => ({
  state: replay(base, []),
  tracks: ["a", "b", "c"],
  selection: null,
  playheadSec: 2,
  options,
  userId: "u1",
  ...patch,
});
const clip = (patch: Partial<EditClip> = {}): EditClip => ({
  id: "k",
  sourceVersionId: "v",
  sourceStartFrame: 0,
  startFrame: SR,
  lengthFrames: 2 * SR,
  gainDb: 0,
  fadeInFrames: 0,
  fadeOutFrames: 0,
  fadeInShape: "equalPower",
  fadeOutShape: "equalPower",
  ...patch,
});

describe("ops from the toolbar", () => {
  it("splits at the playhead, or at both selection edges inside the song", () => {
    expect(splitFrames(target())).toEqual([2 * SR]);
    expect(splitFrames(target({ selection: { start: 1, end: 3 } }))).toEqual([SR, 3 * SR]);
    expect(splitFrames(target({ selection: { start: 0, end: 3 } }))).toEqual([3 * SR]);
    expect(splitFrames(target({ playheadSec: 0 }))).toEqual([]);
    expect(splitFrames(target({ playheadSec: 10 }))).toEqual([]);
    const op = splitOp(target());
    expect(op).toMatchObject({ type: "split", frames: [2 * SR], tracks: ["a", "b", "c"] });
    expect(op?.timeline).toEqual(FOLLOW_ALL);
    expect(op?.userId).toBe("u1");
    expect(splitOp(target({ playheadSec: 0 }))).toBeNull();
    expect(splitOp(target({ tracks: [] }))).toBeNull();
  });

  it("needs a selection for range ops and clamps it to the song", () => {
    expect(rangeOp(target(), "cut")).toBeNull();
    const cut = rangeOp(target({ selection: { start: 1, end: 20 } }), "cut");
    expect(cut).toMatchObject({ type: "cut", range: { start: SR, end: 10 * SR } });
    expect(cut && "fades" in cut && cut.fades).toEqual(DEFAULT_EDIT_FADES);
    expect(rangeOp(target({ selection: { start: 11, end: 20 } }), "silence")).toBeNull();
    const gain = rangeOp(target({ selection: { start: 1, end: 2 }, tracks: ["b"] }), "gain", -99);
    expect(gain).toMatchObject({ type: "gain", gainDb: -60, tracks: ["b"] });
  });

  it("says why an action is unavailable", () => {
    expect(unavailable("cut", target())).toBe("noRange");
    expect(unavailable("cut", target({ selection: { start: 1, end: 2 } }))).toBeNull();
    expect(unavailable("split", target({ tracks: [] }))).toBe("noTracks");
    expect(unavailable("split", target({ playheadSec: 0 }))).toBe("outsideSong");
    expect(unavailable("splitAtMarkers", target())).toBeNull();
  });

  it("splits at the chosen markers and section edges", () => {
    const points = splitPoints(
      [
        { id: "m1", name: "Solo", startSec: 4, endSec: null },
        { id: "s1", name: "Verse", startSec: 0, endSec: 3 },
        { id: "m2", name: "Late", startSec: 30, endSec: null },
      ],
      10,
    );
    expect(points.map((p) => [p.key, p.sec, p.kind])).toEqual([
      ["s1:end", 3, "sectionEnd"],
      ["m1", 4, "marker"],
    ]);
    const op = splitAtMarkersOp(
      target(),
      points.map((p) => ({ id: p.markerId, sec: p.sec })),
    );
    expect(op).toMatchObject({ type: "splitAtMarkers", frames: [3 * SR, 4 * SR] });
    expect(op?.type === "splitAtMarkers" && op.markerIds).toEqual(["s1", "m1"]);
    expect(splitAtMarkersOp(target(), [])).toBeNull();
  });

  it("builds moves and trims with the current overlap mode and fades", () => {
    const o = { options: { ...options, overlap: "block" as const }, userId: "u" };
    expect(moveOp(o, ["x"], 10, "b")).toMatchObject({
      type: "move",
      clipIds: ["x"],
      deltaFrames: 10,
      toTrackId: "b",
      overlap: "block",
    });
    expect(trimOp(o, "x", "end", -5)).toMatchObject({ type: "trim", edge: "end", deltaFrames: -5 });
  });
});

describe("clip geometry", () => {
  const view = { startSec: 0, pxPerSec: 100, widthPx: 500 };

  it("lays out visible clips per lane and clamps huge ones", () => {
    const boxes = clipBoxes(view, [
      { clips: [clip(), clip({ id: "far", startFrame: 100 * SR })] },
      { clips: [clip({ id: "long", startFrame: 0, lengthFrames: 3600 * SR })] },
    ]);
    expect(boxes.map((b) => [b.clip.id, b.trackIndex])).toEqual([
      ["k", 0],
      ["long", 1],
    ]);
    expect(boxes[0]).toMatchObject({ x0: 100, x1: 300, left: 100, width: 200 });
    expect(boxes[0]?.startVisible && boxes[0].endVisible).toBe(true);
    expect(boxes[1]).toMatchObject({ left: 0, width: 548, endVisible: false });
  });

  it("draws fades from silence to full and back", () => {
    expect(fadePath(10, 20, "linear", "in")).toBe("M0.0,20.0L10.0,0.0");
    expect(fadePath(10, 20, "linear", "out")).toBe("M0.0,0.0L10.0,20.0");
    const ep = fadePath(16, 10, "equalPower", "in").split("L");
    expect(ep).toHaveLength(17);
    expect(ep.at(-1)).toBe("16.0,0.0");
  });
});

describe("drags to ops", () => {
  const state = replay(base, []);
  const a = state.tracks[0]?.clips[0] as EditClip;
  const c = state.tracks[2]?.clips[0] as EditClip;
  const view = { pxPerSec: 100 };

  it("moves by the drag, clamped at the song start", () => {
    const d = { clipIds: [a.id], grabbed: a, fromTrack: 0, grabY: 10 };
    expect(moveFromDrag(d, state, 50, 0, view, 60, null)).toEqual({
      deltaFrames: SR / 2,
      toTrack: null,
      snappedSec: null,
    });
    expect(moveFromDrag(d, state, -500, 0, view, 60, null).deltaFrames).toBe(0);
    const dc = { clipIds: [c.id], grabbed: c, fromTrack: 2, grabY: 10 };
    expect(moveFromDrag(dc, state, -500, 0, view, 60, null).deltaFrames).toBe(-SR);
  });

  it("targets the lane past the lane edge for clips of one track", () => {
    const d = { clipIds: [a.id], grabbed: a, fromTrack: 0, grabY: 50 };
    expect(moveFromDrag(d, state, 0, 9, view, 60, null).toTrack).toBeNull();
    expect(moveFromDrag(d, state, 0, 11, view, 60, null).toTrack).toBe(1);
    expect(moveFromDrag(d, state, 0, 500, view, 60, null).toTrack).toBe(2);
    expect(moveFromDrag(d, state, 0, -500, view, 60, null).toTrack).toBeNull();
    // Clips of several tracks keep their tracks.
    const both = { clipIds: [a.id, c.id], grabbed: a, fromTrack: 0, grabY: 50 };
    expect(moveFromDrag(both, state, 0, 100, view, 60, null).toTrack).toBeNull();
  });

  it("snaps the grabbed clip's start, else its end", () => {
    const d = { clipIds: [c.id], grabbed: c, fromTrack: 2, grabY: 0 };
    const snapTo = (t: number) => (sec: number) => (Math.abs(sec - t) < 0.1 ? t : sec);
    // Start 1 s + 0.95 s → 2 s.
    expect(moveFromDrag(d, state, 95, 0, view, 60, snapTo(2))).toMatchObject({
      deltaFrames: SR,
      snappedSec: 2,
    });
    // End 9 s + 0.95 s → 10 s (the start is not near anything).
    expect(moveFromDrag(d, state, 95, 0, view, 60, snapTo(10))).toMatchObject({
      deltaFrames: SR,
      snappedSec: 10,
    });
  });

  it("lists other clips' edges as snap targets", () => {
    expect(clipEdges(state, new Set([a.id]))).toEqual([0, 1, 9, 10]);
  });

  it("trims an edge by the drag, keeping at least one frame", () => {
    const k = clip();
    expect(trimFromDrag(k, "start", 50, view, null)).toEqual({
      deltaFrames: SR / 2,
      snappedSec: null,
    });
    expect(trimFromDrag(k, "start", 5000, view, null).deltaFrames).toBe(2 * SR - 1);
    expect(trimFromDrag(k, "end", -5000, view, null).deltaFrames).toBe(1 - 2 * SR);
    expect(trimFromDrag(k, "start", -500, view, null).deltaFrames).toBe(-SR);
    const snap = (sec: number) => (Math.abs(sec - 3.5) < 0.1 ? 3.5 : sec);
    expect(trimFromDrag(k, "end", 45, view, snap)).toEqual({
      deltaFrames: SR / 2,
      snappedSec: 3.5,
    });
  });
});

describe("out of sync", () => {
  it("marks tracks shifted by a cut on a subset", () => {
    const cut = (tracks: string[]) =>
      rangeOp(target({ selection: { start: 1, end: 2 }, tracks }), "cut");
    const all = cut(["a", "b", "c"]);
    const sub = cut(["c"]);
    if (!all || !sub) throw new Error("no op");
    expect(outOfSync([all], 1, ["a", "b", "c"])).toEqual({});
    expect(outOfSync([all, sub], 2, ["a", "b", "c"])).toEqual({ c: 2 });
    expect(outOfSync([all, sub], 1, ["a", "b", "c"])).toEqual({});
    // A tie keeps the unshifted tracks in sync.
    expect(outOfSync([sub], 1, ["a", "c"])).toEqual({ c: 1 });
  });
});

describe("edit shortcuts", () => {
  const key = (
    k: string,
    mods: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>> = {},
  ) =>
    resolveEditKey({
      key: k,
      code: "",
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      ...mods,
    });

  it("maps the edit keys", () => {
    expect(key("x")).toBe("split");
    expect(key("X")).toBe("split");
    expect(key("s")).toBeNull(); // snap cycle stays
    expect(key("Delete")).toBe("cut");
    expect(key("Backspace")).toBe("cut");
    expect(key("Delete", { shiftKey: true })).toBe("silence");
    expect(key("g")).toBe("gain");
    expect(key("Escape")).toBe("escape");
    expect(key("z", { metaKey: true })).toBe("undo");
    expect(key("z", { ctrlKey: true })).toBe("undo");
    expect(key("Z", { ctrlKey: true, shiftKey: true })).toBe("redo");
    expect(key("y", { ctrlKey: true })).toBe("redo");
    expect(key("y", { metaKey: true })).toBeNull();
    expect(key("x", { altKey: true })).toBeNull();
    expect(key("x", { shiftKey: true })).toBeNull();
    expect(key("c", { ctrlKey: true })).toBeNull();
  });
});
