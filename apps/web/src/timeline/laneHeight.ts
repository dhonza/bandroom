import { useCallback } from "react";
import { create } from "zustand";

/**
 * Vertical zoom (SPEC §25.9): the height of the timeline's waveform lanes, remembered per device
 * and per view (desktop tracks, phone summed or stacked, Listen tracks). Browser storage may be
 * unavailable (private mode); the height then lasts for the page only.
 */
export const MIN_LANE_H = 28;
export const MAX_LANE_H = 240;
/** One +/- step. */
export const LANE_STEP = 1.25;

const KEY = "bandroom.laneHeights";

export function clampLaneHeight(h: number, min = MIN_LANE_H): number {
  return Math.round(Math.min(MAX_LANE_H, Math.max(min, h)));
}

/** The height after zooming `h` by `factor`; always moves at least 1 px when not at a limit. */
export function zoomLaneHeight(h: number, factor: number, min = MIN_LANE_H): number {
  const next = clampLaneHeight(h * factor, min);
  if (next !== clampLaneHeight(h, min) || factor === 1) return next;
  return clampLaneHeight(h + (factor > 1 ? 1 : -1), min);
}

function load(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const out: Record<string, number> = {};
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = clampLaneHeight(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function save(heights: Record<string, number>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(heights));
  } catch {
    // per-device convenience only
  }
}

export const useLaneHeights = create<{ heights: Record<string, number> }>(() => ({
  heights: load(),
}));

export function setLaneHeight(key: string, h: number): void {
  const heights = { ...useLaneHeights.getState().heights, [key]: clampLaneHeight(h) };
  save(heights);
  useLaneHeights.setState({ heights });
}

/**
 * The lane height of view `key` (`fallback` until the user zooms) and its setter (+/- buttons,
 * Alt+wheel, vertical pinch). `min` raises the floor (touch Mixer); a lower stored height is
 * clamped on read.
 */
export function useLaneHeight(
  key: string,
  fallback: number,
  min = MIN_LANE_H,
): [number, (h: number) => void] {
  const stored = useLaneHeights((s) => s.heights[key]);
  const set = useCallback(
    (h: number) => {
      setLaneHeight(key, clampLaneHeight(h, min));
    },
    [key, min],
  );
  return [clampLaneHeight(stored ?? fallback, min), set];
}
