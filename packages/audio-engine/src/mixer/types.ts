import type { TakeMessage } from "./capture";
import type { ClickSound } from "./click";

/** Mixer constants and the types shared by the mixer, its protocol and the engine. */

export const FADE_FRAMES = 240; // 5 ms transport fades and loop-wrap crossfade (SPEC §6.6)
export const RAMP_FRAMES = 960; // 20 ms gain ramps (SPEC §6.6)
export const REPORT_FRAMES = 2400; // position and meters every 50 ms (SPEC §6.6)
/** Laps reserved per seek; loop repeats count up within one base. */
export const LAPS_PER_SEEK = 2 ** 20;

export interface ClipRange {
  start: number;
  end: number;
}

export interface MixerTrackConfig {
  id: string;
  /** Source (decoded clip data) currently playing, numbered by the engine. */
  source: number;
  channels: number;
  /** One stored channel of a dual-mono upload: pans with the stereo law (SPEC §6.6). */
  dualMono?: boolean;
  /** Timeline ranges that have audio; frames outside are silent without counting as underrun. */
  clips: ClipRange[];
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Gain of the playing version in dB (SPEC §25.6); 0 when omitted. */
  trimDb?: number;
}

export interface TrackParams {
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Extra gain for loudness-matched A/B (SPEC §6.9). */
  offsetDb: number;
  /** The playing version's own gain (SPEC §25.6), before the fader and pan. */
  trimDb: number;
}

export type TransportState = "stopped" | "buffering" | "playing";

/** The click (SPEC §6.6, §6.7): own mute (enabled) and solo, solo-safe unless `soloExcludes`. */
export interface ClickParams {
  enabled: boolean;
  gainDb: number;
  /** Accented (louder, higher) downbeats. */
  accent: boolean;
  sound: ClickSound;
  solo: boolean;
  /** "Solo excludes click": a soloed track mutes the click (unless it is soloed too). */
  soloExcludes: boolean;
}

export const DEFAULT_CLICK: ClickParams = {
  enabled: false,
  gainDb: 0,
  accent: true,
  sound: "woodblock",
  solo: false,
  soloExcludes: false,
};

/** Position, meters and underruns, every 50 ms (one message, SPEC §6.6). */
export interface MixerReport {
  type: "report";
  frame: number;
  lap: number;
  time: number;
  playing: boolean;
  /** Count-in frames still to play before the timeline audio (0 when none). */
  preroll: number;
  prerollInterval: number;
  prerollClicks: number;
  /** Clicks triggered since load (debug state). */
  clicks: number;
  /** Peak per track (post fader), then master left and right, since the previous report. */
  peaks: Float32Array;
  /** Underrun frames per track since the previous report. */
  underruns: Float32Array;
  /** Input peak per channel (left, right) since the previous report; 0 while not armed. */
  inputPeaks: Float32Array;
  /** A take is being recorded (`recFrames` long so far). */
  recording: boolean;
  recFrames: number;
}

export type MixerEvent =
  | { type: "state"; state: TransportState }
  | MixerReport
  | { type: "ended" }
  /** Recording (SPEC §9): routed to the take port; `take.start`/`take.end` also to the engine. */
  | TakeMessage
  /**
   * A loop change was applied at `(fromLap, frame)`; the lap continues as `base`. Sent to the
   * decoder worker (not the main thread) so it can relabel its producers without a rebuffer.
   */
  | {
      type: "retime";
      fromLap: number;
      frame: number;
      base: number;
      loop: ClipRange | null;
      cache: boolean;
    };
