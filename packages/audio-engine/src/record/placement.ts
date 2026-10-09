import { SAMPLE_RATE } from "../constants";

/**
 * Where a take goes on the timeline (SPEC §9). There is no calibration: the latency is estimated
 * from what the browser reports, and the user nudges the result.
 *
 * The mixer captures input frame `i` together with output frame `i` of the same render quantum.
 * What the player heard at output frame `i` comes out of the speakers `outputLatency` later, and
 * the microphone's signal reaches the input `inputLatency` (plus about one quantum of buffering)
 * after it was played, so the recording is late by their sum.
 */

/** Latency parts for placing a take, in seconds. */
export interface RecordingLatency {
  /** `outputLatency`, or `baseLatency` where that is missing. */
  outputSec: number;
  /** The input track's reported `latency` setting (0 when not reported). */
  inputSec: number;
}

/** One render quantum of input buffering. */
export const QUANTUM_FRAMES = 128;

/** Above this estimate the output is probably Bluetooth (SPEC §9 warning). */
export const BLUETOOTH_LATENCY_SEC = 0.1;

/** Round-trip latency in frames: output + input + one render quantum. */
export function latencyFrames(l: RecordingLatency): number {
  // Missing or nonsense reports (negative, NaN) count as zero.
  const pos = (x: number) => (x > 0 ? x : 0);
  const sec = pos(l.outputSec) + pos(l.inputSec);
  return Math.round(sec * SAMPLE_RATE) + QUANTUM_FRAMES;
}

export interface TakePlacement {
  /** The version's `offsetSamples` (timeline frame of the file's first frame), ≥ 0. */
  offsetSamples: number;
  /** Frames to drop from the head of the take when it would start before the song start. */
  trimHead: number;
}

/**
 * Places a take recorded from timeline frame `startFrame`: it moves earlier by the latency.
 * `nudgeFrames` moves it later (positive) or earlier (negative), as the stop dialog's ± buttons
 * do; a nudge is the same as a latency that much smaller.
 */
export function placeTake(startFrame: number, latency: number, nudgeFrames = 0): TakePlacement {
  const at = Math.round(startFrame - latency + nudgeFrames);
  return at >= 0 ? { offsetSamples: at, trimHead: 0 } : { offsetSamples: 0, trimHead: -at };
}

/** Bluetooth-looking device names (AirPods, Buds, hands-free profiles, …). */
const BLUETOOTH_LABEL = /bluetooth|airpods|beats|\bbuds|hands-?free|\bbt\b|wh-1000|wf-1000|jabra/i;

/**
 * Whether to warn about Bluetooth (SPEC §9): a device label looks like it, or the latency
 * estimate is over 100 ms.
 */
export function looksLikeBluetooth(labels: readonly string[], latency: RecordingLatency): boolean {
  if (latency.outputSec + latency.inputSec > BLUETOOTH_LATENCY_SEC) return true;
  return labels.some((l) => BLUETOOTH_LABEL.test(l));
}

/** Milliseconds → frames at 48 kHz (the nudge buttons work in ms). */
export function msToFrames(ms: number): number {
  return Math.round((ms * SAMPLE_RATE) / 1000);
}
