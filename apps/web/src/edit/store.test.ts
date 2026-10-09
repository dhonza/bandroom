import { initialClip, type EditBase } from "@bandroom/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { clipEnvelopeAt } from "../timeline/render";
import { moveOp, rangeOp, splitOp } from "./model";
import {
  clearPick,
  DEFAULT_EDIT_OPTIONS,
  enterEdit,
  exitEdit,
  pickClip,
  redoEdit,
  resetEditForTests,
  runOp,
  savedAt,
  setEditOptions,
  toggleTrackSelected,
  undoEdit,
  useEdit,
} from "./store";

const SR = 48_000;
const track = (id: string) => {
  const t = {
    trackId: id,
    versionId: `v-${id}`,
    offsetSamples: 0,
    gainDb: 0,
    lengthFrames: 10 * SR,
  };
  return { ...t, clip: initialClip(t) };
};
const base: EditBase = { tracks: [track("a"), track("b")], remap: [], foldedOps: 0 };
const ctx = { options: DEFAULT_EDIT_OPTIONS, userId: "u" };
const target = () => {
  const s = useEdit.getState();
  if (!s.state) throw new Error("not editing");
  return {
    ...ctx,
    state: s.state,
    tracks: s.selectedTracks,
    selection: { start: 1, end: 2 },
    playheadSec: 3,
  };
};

beforeEach(() => {
  resetEditForTests();
  enterEdit({
    session: { id: "s1", songId: "song", rev: 0 },
    base,
    ops: [],
    cursor: 0,
    options: DEFAULT_EDIT_OPTIONS,
    versions: {},
  });
});

describe("edit store", () => {
  it("runs ops, undoes and redoes by the cursor, and marks changes for the autosave", () => {
    expect(useEdit.getState().selectedTracks).toEqual(["a", "b"]);
    const split = splitOp({ ...target(), selection: null });
    if (!split) throw new Error("no op");
    expect(runOp(split)).toBeNull();
    let s = useEdit.getState();
    expect(s.state?.tracks.map((t) => t.clips.length)).toEqual([2, 2]);
    expect(s).toMatchObject({ cursor: 1, dirty: true, save: "unsaved", changeSeq: 1 });
    expect(undoEdit()).toBe(true);
    expect(useEdit.getState().state?.tracks.map((t) => t.clips.length)).toEqual([1, 1]);
    expect(undoEdit()).toBe(false);
    expect(redoEdit()).toBe(true);
    expect(redoEdit()).toBe(false);
    s = useEdit.getState();
    expect(s.cursor).toBe(1);
    savedAt(4, s.changeSeq);
    expect(useEdit.getState()).toMatchObject({ dirty: false, save: "saved", session: { rev: 4 } });
  });

  it("refuses ops the model refuses, without storing them", () => {
    const op = rangeOp({ ...target(), selection: null }, "cut");
    expect(op).toBeNull();
    const move = moveOp(ctx, ["nope"], 10, null);
    expect(runOp(move)).toBe("unknownClip");
    expect(useEdit.getState().ops).toHaveLength(0);
  });

  it("acts on the selected tracks and keeps picks of clips that still exist", () => {
    toggleTrackSelected("a");
    expect(useEdit.getState().selectedTracks).toEqual(["b"]);
    const clipA = useEdit.getState().state?.tracks[0]?.clips[0]?.id ?? "";
    pickClip(clipA, false);
    pickClip("x", true);
    expect(useEdit.getState().picked).toEqual([clipA, "x"]);
    pickClip("x", true);
    const cut = rangeOp(target(), "cut");
    if (!cut) throw new Error("no op");
    runOp(cut);
    expect(useEdit.getState().state?.tracks.map((t) => t.clips.length)).toEqual([1, 2]);
    expect(useEdit.getState().picked).toEqual([clipA]);
    expect(clearPick()).toBe(true);
    expect(clearPick()).toBe(false);
  });

  it("keeps options for the next ops and leaves edit mode", () => {
    setEditOptions({ overlap: "block" });
    expect(useEdit.getState()).toMatchObject({ options: { overlap: "block" }, dirty: true });
    exitEdit();
    expect(useEdit.getState()).toMatchObject({ songId: null, session: null, state: null });
  });
});

describe("clip envelope on the lanes", () => {
  it("follows the fades", () => {
    const c = {
      startSec: 0,
      endSec: 2,
      sourceStartSec: 0,
      peaks: null,
      scale: 1,
      fadeInSec: 1,
      fadeOutSec: 0.5,
      fadeInShape: "linear" as const,
      fadeOutShape: "equalPower" as const,
    };
    expect(clipEnvelopeAt(c, 0.5)).toBeCloseTo(0.5);
    expect(clipEnvelopeAt(c, 1.2)).toBe(1);
    expect(clipEnvelopeAt(c, 1.75)).toBeCloseTo(Math.sin(Math.PI / 4));
  });
});
