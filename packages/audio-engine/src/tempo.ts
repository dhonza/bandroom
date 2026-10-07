import { clickFrames, countInAt, type ClickOptions, type TempoGrid } from "@bandroom/shared";
import { SAMPLE_RATE } from "./constants";
import type { ClickTrack, CountInSpec } from "./mixer/click";

/**
 * Beat positions for the worklet, pre-computed on the main thread from the tempo map into a
 * frame-indexed list for the whole song (SPEC §6.7), including pickup bars before bar 1. The
 * bounce renders the same frames (`clickFrames`, SPEC §5.5).
 */
export function clickTrackFor(
  grid: TempoGrid,
  lengthFrames: number,
  opts: ClickOptions,
): ClickTrack {
  return clickFrames(grid, lengthFrames, opts);
}

/** Count-in before `frame` with the tempo and meter in effect there (SPEC §6.7). */
export function countInSpecAt(
  grid: TempoGrid,
  frame: number,
  bars: number,
  compoundEighths: boolean,
): CountInSpec {
  const c = countInAt(grid, frame / SAMPLE_RATE, bars, compoundEighths);
  return { clicks: c.clicks, perBar: c.perBar, intervalFrames: c.intervalSec * SAMPLE_RATE };
}
