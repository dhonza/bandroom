import { msToFrames, SAMPLE_RATE } from "@bandroom/audio-engine";
import { MAX_OFFSET_SAMPLES } from "@bandroom/shared";
import type { TakeMeta } from "./takeTypes";

/**
 * Where a take goes on the timeline with the user's nudge (SPEC §9): the start minus the latency,
 * later by a positive nudge. The writer already dropped the head that reached before the song
 * start (`trimmedFrames`), so the file starts that much later; the result is never below 0 (a
 * take at the song start cannot move earlier than 0, as with Adjust position).
 */
export function takeOffsetSamples(
  meta: Pick<TakeMeta, "startFrame" | "trimmedFrames" | "latencyFrames">,
  nudgeMs: number,
): number {
  const at = meta.startFrame + meta.trimmedFrames - meta.latencyFrames + msToFrames(nudgeMs);
  return Math.min(MAX_OFFSET_SAMPLES, Math.max(0, Math.round(at)));
}

/** The nudge buttons' steps in ms (SPEC §9). */
export const NUDGE_STEPS = [1, 10, 100] as const;
/** The nudge field's range (ms). */
export const MAX_NUDGE_MS = 2000;

export function clampNudge(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(-MAX_NUDGE_MS, Math.min(MAX_NUDGE_MS, Math.round(ms)));
}

/** The input gain's range and step in dB (digital gain before writing, SPEC §9). */
export const INPUT_GAIN_MIN_DB = 0;
export const INPUT_GAIN_MAX_DB = 40;
export const INPUT_GAIN_STEP_DB = 0.5;

/** An input gain within its range (0 for a non-number), to 0.01 dB. */
export function clampInputGain(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const v = Math.max(INPUT_GAIN_MIN_DB, Math.min(INPUT_GAIN_MAX_DB, db));
  return Math.round(v * 100) / 100;
}

/** "Recording N" with the next free N among the track names (base = the localized word). */
export function nextRecordingName(base: string, names: readonly string[]): string {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+)$`, "i");
  let max = 0;
  for (const n of names) {
    const m = re.exec(n.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${base} ${String(max + 1)}`;
}

/**
 * Bytes of a take: 24-bit FLAC is about 0.6 × the raw size on music (SPEC §9 estimate), plus 10 %
 * headroom. Used for the quota and local storage checks before arming.
 */
export function estimateTakeBytes(minutes: number, channels: number): number {
  return Math.ceil(minutes * 60 * SAMPLE_RATE * channels * 3 * 0.6 * 1.1);
}

/** Whole minutes of recording that fit in `bytes`. */
export function minutesThatFit(bytes: number, channels: number): number {
  const perMinute = estimateTakeBytes(1, channels);
  return Math.max(0, Math.floor(bytes / perMinute));
}

/** m:ss (or h:mm:ss) of a frame count, for the timer and take lists. */
export function formatTakeTime(frames: number): string {
  const total = Math.max(0, Math.floor(frames / SAMPLE_RATE));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${String(h)}:${String(m).padStart(2, "0")}:${ss}` : `${String(m)}:${ss}`;
}

/** Timeline position in seconds with milliseconds, for the placement readout. */
export function formatOffset(samples: number): string {
  const sec = samples / SAMPLE_RATE;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m)}:${s.toFixed(3).padStart(6, "0")}`;
}

/** Input level of a linear peak on a 0–100 scale over −60…0 dBFS (the meter). */
export function meterPercent(peak: number): number {
  if (peak <= 0) return 0;
  const db = 20 * Math.log10(peak);
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}
