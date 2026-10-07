import { describe, expect, it } from "vitest";
import {
  moveGesture,
  pastTapSlop,
  pinchAxis,
  releaseAction,
  startGesture,
  type Gesture,
} from "./gesture";

const g = (kind: Gesture["kind"]): Gesture => ({ kind });

describe("timeline gestures", () => {
  it("starts a selection drag on the ruler or with a mouse, when selecting is possible", () => {
    expect(startGesture(true, true, false)).toEqual(g("selectPending"));
    expect(startGesture(true, false, true)).toEqual(g("selectPending"));
    expect(startGesture(true, false, false)).toEqual(g("pending"));
    expect(startGesture(false, true, true)).toEqual(g("pending"));
  });

  it("treats moves within the tap slop as a tap", () => {
    expect(pastTapSlop(106, 100)).toBe(false);
    expect(pastTapSlop(107, 100)).toBe(true);
    expect(pastTapSlop(93, 100)).toBe(true);
  });

  it("turns a moved touch into a scroll and a moved press into a selection", () => {
    expect(moveGesture(g("pending"), true, true)).toEqual(g("scroll"));
    expect(moveGesture(g("selectPending"), true, true)).toEqual(g("select"));
    expect(moveGesture(g("longPress"), true, true)).toEqual(g("select"));
    const lp = g("longPress");
    expect(moveGesture(lp, true, false)).toBe(lp);
    const pending = g("pending");
    expect(moveGesture(pending, false, true)).toBe(pending);
    const scroll = g("scroll");
    expect(moveGesture(scroll, true, true)).toBe(scroll);
  });

  it("ends a selection, opens the long-press menu or taps on release", () => {
    expect(releaseAction(g("select"), 0, true)).toBe("select");
    expect(releaseAction(g("select"), 0, false)).toBeNull();
    expect(releaseAction(g("longPress"), 0, false)).toBe("longPress");
    expect(releaseAction(g("pending"), 0, false)).toBe("tap");
    expect(releaseAction(g("selectPending"), 0, true)).toBe("tap");
    expect(releaseAction(g("pending"), 1, true)).toBeNull();
    expect(releaseAction(g("scroll"), 0, true)).toBeNull();
    expect(releaseAction(g("pinch"), 0, true)).toBeNull();
  });
});

describe("pinch axis (SPEC §25.9)", () => {
  it("zooms lanes with fingers one above the other, time otherwise", () => {
    expect(pinchAxis({ x: 100, y: 10 }, { x: 110, y: 90 }, true)).toBe("lanes");
    expect(pinchAxis({ x: 10, y: 50 }, { x: 200, y: 60 }, true)).toBe("time");
    // Diagonal: time, as before.
    expect(pinchAxis({ x: 0, y: 0 }, { x: 60, y: 80 }, true)).toBe("time");
    expect(pinchAxis({ x: 100, y: 10 }, { x: 110, y: 90 }, false)).toBe("time");
  });
});
