import { describe, expect, it } from "vitest";
import { clampZoom, pageScrollTarget, pinchDistance } from "./zoom";

describe("document viewer zoom and paging", () => {
  it("clamps zoom", () => {
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(10)).toBe(5);
    expect(clampZoom(1.234)).toBe(1.23);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("measures pinches", () => {
    expect(
      pinchDistance([
        { x: 0, y: 0 },
        { x: 3, y: 4 },
      ]),
    ).toBe(5);
    expect(pinchDistance([{ x: 0, y: 0 }])).toBe(0);
  });

  it("pages text by a screenful with overlap, within bounds", () => {
    expect(pageScrollTarget(0, 1000, 5000, "next")).toBe(900);
    expect(pageScrollTarget(3900, 1000, 5000, "next")).toBe(4000);
    expect(pageScrollTarget(500, 1000, 5000, "prev")).toBe(0);
    expect(pageScrollTarget(0, 1000, 800, "next")).toBe(0);
    expect(pageScrollTarget(0, 10, 5000, "next")).toBe(40);
  });
});
