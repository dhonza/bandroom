import type { ClipRange } from "./mixer/types";
import {
  clipRanges,
  type EngineClip,
  type EnginePractice,
  type TrackStretchPolicy,
  type WorkerStretch,
} from "./types";

// Time model (SPEC §30.5): the decoder worker and the mixer work in playback frames
// `p = t / rate`; the engine API stays in timeline frames `t` and converts at its boundary.

export const NEUTRAL_PRACTICE: EnginePractice = { rate: 1, semitones: 0, quality: "high" };

export const DEFAULT_STRETCH_POLICY: TrackStretchPolicy = {
  transpose: true,
  profile: "tonal",
  voiceBaseHz: 0,
  formant: false,
  formantShift: 0,
};

/** Speed 100 % and no transposition: tracks play as they are. */
export function isNeutralPractice(p: EnginePractice): boolean {
  return p.rate === 1 && p.semitones === 0;
}

export function samePractice(a: EnginePractice, b: EnginePractice): boolean {
  return a.rate === b.rate && a.semitones === b.semitones && a.quality === b.quality;
}

/** Song length in playback frames. */
export function playbackLength(timelineFrames: number, rate: number): number {
  return Math.ceil(timelineFrames / rate);
}

/** Timeline frame → playback frame. */
export function toPlayback(t: number, rate: number): number {
  return rate === 1 ? t : Math.round(t / rate);
}

/** Playback frame → timeline frame. */
export function toTimeline(p: number, rate: number): number {
  return rate === 1 ? p : p * rate;
}

/**
 * How the worker plays a track: null = as is (neutral practice without a formant shift, or a
 * track kept at its pitch at 100 %, bit-identical to the source); else stretched, or silent when
 * muted. A formant shift alone is processed at 100 % / 0 st too (SPEC §30.3).
 */
export function workerStretch(
  practice: EnginePractice,
  policy: TrackStretchPolicy | undefined,
  muted: boolean,
  clips: EngineClip[],
  timelineFrames: number,
): WorkerStretch | null {
  const p = policy ?? DEFAULT_STRETCH_POLICY;
  const shift = p.formantShift;
  if (isNeutralPractice(practice) && shift === 0) return null;
  const semitones = p.transpose ? practice.semitones : 0;
  if (!muted && practice.rate === 1 && semitones === 0 && shift === 0) return null;
  return {
    rate: practice.rate,
    semitones,
    profile: p.profile,
    quality: practice.quality,
    voiceBaseHz: p.voiceBaseHz,
    formant: p.formant,
    formantShift: shift,
    channels: clips[0]?.variant.channels ?? 2,
    silent: muted,
    timelineFrames,
  };
}

/**
 * The ranges the mixer expects data in: a stretched or silenced track produces data for the
 * whole song (the stretcher's tail runs past a clip end).
 */
export function mixerClips(
  clips: EngineClip[],
  stretch: WorkerStretch | null | undefined,
  lengthFrames: number,
): ClipRange[] {
  return stretch ? [{ start: 0, end: lengthFrames }] : clipRanges(clips);
}
