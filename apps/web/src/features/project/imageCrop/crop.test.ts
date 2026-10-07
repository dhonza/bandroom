import { describe, expect, it } from "vitest";
import {
  clampSquare,
  defaultSquare,
  moveSquare,
  nudgeSquare,
  outputSide,
  resizeFromCorner,
} from "./crop";

const wide = { width: 1600, height: 900 };
const tall = { width: 600, height: 1000 };

describe("square crop geometry (SPEC §25.4)", () => {
  it("starts with the largest centred square", () => {
    expect(defaultSquare(wide)).toEqual({ x: 350, y: 0, size: 900 });
    expect(defaultSquare(tall)).toEqual({ x: 0, y: 200, size: 600 });
    expect(defaultSquare({ width: 10, height: 10 })).toEqual({ x: 0, y: 0, size: 10 });
  });

  it("moves within the image", () => {
    const s = defaultSquare(wide);
    expect(moveSquare(s, 100, 50, wide)).toEqual({ x: 450, y: 0, size: 900 });
    expect(moveSquare(s, 10_000, 0, wide)).toEqual({ x: 700, y: 0, size: 900 });
    expect(moveSquare(s, -10_000, 0, wide)).toEqual({ x: 0, y: 0, size: 900 });
  });

  it("resizes from each corner with the opposite corner fixed", () => {
    const s = { x: 400, y: 200, size: 400 };
    expect(resizeFromCorner(s, "se", 100, 100, wide)).toEqual({ x: 400, y: 200, size: 500 });
    expect(resizeFromCorner(s, "se", 100, 0, wide)).toEqual({ x: 400, y: 200, size: 450 });
    expect(resizeFromCorner(s, "nw", 100, 100, wide)).toEqual({ x: 500, y: 300, size: 300 });
    expect(resizeFromCorner(s, "ne", 50, -50, wide)).toEqual({ x: 400, y: 150, size: 450 });
    expect(resizeFromCorner(s, "sw", -50, 50, wide)).toEqual({ x: 350, y: 200, size: 450 });
  });

  it("limits resizing to the room towards the corner and to the minimum", () => {
    const s = { x: 400, y: 200, size: 400 };
    // Bottom edge at 600; the image is 900 high, so 300 more at most.
    expect(resizeFromCorner(s, "se", 5000, 5000, wide)).toEqual({ x: 400, y: 200, size: 700 });
    // nw: fixed corner (800, 600); up to 600 towards the top.
    expect(resizeFromCorner(s, "nw", -5000, -5000, wide)).toEqual({ x: 200, y: 0, size: 600 });
    expect(resizeFromCorner(s, "se", -5000, -5000, wide).size).toBe(32);
  });

  it("clamps a square that does not fit", () => {
    expect(clampSquare({ x: -10, y: 950, size: 5000 }, wide)).toEqual({ x: 0, y: 0, size: 900 });
    expect(clampSquare({ x: 0, y: 0, size: 1 }, wide).size).toBe(32);
  });

  it("nudges with the keyboard", () => {
    const s = { x: 400, y: 200, size: 400 };
    expect(nudgeSquare(s, "ArrowRight", 10, wide)).toEqual({ x: 410, y: 200, size: 400 });
    expect(nudgeSquare(s, "ArrowUp", 10, wide)).toEqual({ x: 400, y: 190, size: 400 });
    expect(nudgeSquare(s, "ArrowLeft", 10, wide)?.x).toBe(390);
    expect(nudgeSquare(s, "ArrowDown", 10, wide)?.y).toBe(210);
    expect(nudgeSquare(s, "+", 10, wide)).toEqual({ x: 390, y: 190, size: 420 });
    expect(nudgeSquare(s, "-", 10, wide)).toEqual({ x: 410, y: 210, size: 380 });
    expect(nudgeSquare(s, "+", 1000, wide)).toEqual({ x: 150, y: 0, size: 900 });
    expect(nudgeSquare(s, "Enter", 10, wide)).toBeNull();
  });

  it("outputs at most 1024 px", () => {
    expect(outputSide({ x: 0, y: 0, size: 3000 })).toBe(1024);
    expect(outputSide({ x: 0, y: 0, size: 500.4 })).toBe(500);
    expect(outputSide({ x: 0, y: 0, size: 0.2 })).toBe(1);
  });
});
