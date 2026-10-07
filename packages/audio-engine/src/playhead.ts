import type { CountInSpec } from "./mixer/click";
import type { ClipRange } from "./mixer/types";
import type { CountInState } from "./engineTypes";

/**
 * The playhead between mixer reports (SPEC §6.6, §6.7): pure interpolation from the last report
 * and the frames heard since, so it is testable without an AudioContext.
 */

/** The parts of the mixer's position report the engine keeps. */
export interface Report {
  frame: number;
  lap: number;
  time: number;
  preroll: number;
  prerollInterval: number;
  prerollClicks: number;
  clicks: number;
}

export const NO_REPORT: Report = {
  frame: 0,
  lap: 0,
  time: 0,
  preroll: 0,
  prerollInterval: 0,
  prerollClicks: 0,
  clicks: 0,
};

/** The count-in click being heard `elapsed` frames after report `r`; null when none. */
export function countInAt(r: Report, elapsed: number): CountInState | null {
  if (r.preroll <= 0 || r.prerollInterval <= 0) return null;
  if (elapsed >= r.preroll) return null;
  const done = r.prerollClicks * r.prerollInterval - r.preroll + elapsed;
  const beat = Math.min(r.prerollClicks, Math.floor(done / r.prerollInterval + 1e-6) + 1);
  return { beat: Math.max(1, beat), clicks: r.prerollClicks };
}

/**
 * The timeline frame heard `elapsed` frames after report `r` while playing: it waits while a
 * count-in plays, wraps at the loop end and stops at the song end (`length`).
 */
export function playheadAt(
  r: Report,
  elapsed: number,
  loop: ClipRange | null,
  repeatCountIn: CountInSpec | null,
  length: number,
): number {
  // The playhead waits while a count-in plays.
  let f = r.frame + Math.max(0, elapsed - r.preroll);
  if (loop && r.frame < loop.end && f >= loop.end) {
    // With "count-in every repeat" the next lap waits for its count-in (shown from the report
    // after the wrap): the playhead holds at the loop start.
    const ci = repeatCountIn;
    f =
      ci && ci.clicks > 0 && ci.intervalFrames > 0
        ? loop.start
        : loop.start + ((f - loop.end) % (loop.end - loop.start));
  }
  return Math.min(f, length);
}
