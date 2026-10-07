import { beforeEach, describe, expect, it } from "vitest";
import {
  clampLaneHeight,
  MAX_LANE_H,
  MIN_LANE_H,
  setLaneHeight,
  useLaneHeights,
  zoomLaneHeight,
} from "./laneHeight";

beforeEach(() => {
  localStorage.clear();
  useLaneHeights.setState({ heights: {} });
});

describe("lane height (SPEC §25.9)", () => {
  it("stays within 28–240 px in whole pixels", () => {
    expect(clampLaneHeight(10)).toBe(MIN_LANE_H);
    expect(clampLaneHeight(1000)).toBe(MAX_LANE_H);
    expect(clampLaneHeight(55.6)).toBe(56);
  });

  it("zooms by a factor and always moves a little when it can", () => {
    expect(zoomLaneHeight(80, 1.25)).toBe(100);
    expect(zoomLaneHeight(100, 1 / 1.25)).toBe(80);
    expect(zoomLaneHeight(56, 1.001)).toBe(57); // a tiny wheel step still moves
    expect(zoomLaneHeight(56, 0.999)).toBe(55);
    expect(zoomLaneHeight(MAX_LANE_H, 2)).toBe(MAX_LANE_H);
    expect(zoomLaneHeight(MIN_LANE_H, 0.5)).toBe(MIN_LANE_H);
    expect(zoomLaneHeight(56, 1)).toBe(56);
  });

  it("takes a higher floor (touch Mixer)", () => {
    expect(clampLaneHeight(30, 46)).toBe(46);
    expect(zoomLaneHeight(50, 0.5, 46)).toBe(46);
    expect(zoomLaneHeight(46, 0.999, 46)).toBe(46);
  });

  it("is remembered per view on this device", () => {
    setLaneHeight("rehearse", 120);
    setLaneHeight("listen.stacked", 500);
    expect(JSON.parse(localStorage.getItem("bandroom.laneHeights") ?? "{}")).toEqual({
      rehearse: 120,
      "listen.stacked": MAX_LANE_H,
    });
    expect(useLaneHeights.getState().heights.rehearse).toBe(120);
  });
});
