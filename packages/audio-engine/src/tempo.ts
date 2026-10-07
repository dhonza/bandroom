import { clickPulses, countInAt, type ClickOptions, type TempoGrid } from "@bandroom/shared";
import { SAMPLE_RATE } from "./constants";
import type { ClickTrack, CountInSpec } from "./mixer/click";

/** Pulses are asked for in windows, so `MAX_PULSES` per call never cuts a long recording short. */
const WINDOW_SEC = 600;

/**
 * Beat positions for the worklet, pre-computed on the main thread from the tempo map into a
 * frame-indexed list for the whole song (SPEC §6.7), including pickup bars before bar 1.
 */
export function clickTrackFor(
  grid: TempoGrid,
  lengthFrames: number,
  opts: ClickOptions,
): ClickTrack {
  const endSec = lengthFrames / SAMPLE_RATE;
  const frames: number[] = [];
  const levels: number[] = [];
  for (let from = 0; from < endSec; from += WINDOW_SEC) {
    // A pulse on a window edge comes in both windows; it is kept once.
    for (const p of clickPulses(grid, from, Math.min(endSec, from + WINDOW_SEC), opts)) {
      const f = Math.round(p.sec * SAMPLE_RATE);
      if (f < 0 || f >= lengthFrames || f <= (frames.at(-1) ?? -1)) continue;
      frames.push(f);
      levels.push(p.level);
    }
  }
  return { frames: Float64Array.from(frames), levels: Uint8Array.from(levels) };
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
