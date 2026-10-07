import { clickPulses, type ClickOptions, type TempoGrid } from "./math";

/** Song frames run at 48 kHz (SPEC §6.5). */
const SAMPLE_RATE = 48_000;

/** Pulses are asked for in windows, so `MAX_PULSES` per call never cuts a long recording short. */
const WINDOW_SEC = 600;

/** A song's click pulses: timeline frames at 48 kHz (sorted, unique) and their levels. */
export interface ClickFrames {
  frames: Float64Array;
  /** 0 = bar downbeat, 1 = main pulse, 2 = subdivision. */
  levels: Uint8Array;
}

/**
 * Click pulse frames for a whole song from its tempo map (SPEC §6.7), including pickup bars
 * before bar 1 and only pulses inside `[0, lengthFrames)`. The browser engine plays these, and
 * the bounce renders them (SPEC §5.5), so both put every click on the same frame.
 */
export function clickFrames(
  grid: TempoGrid,
  lengthFrames: number,
  opts: ClickOptions,
): ClickFrames {
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
