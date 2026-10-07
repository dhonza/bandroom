import type { CountInSpec } from "./click";
import type { ClickParams, ClipRange, MixerEvent, MixerTrackConfig, TrackParams } from "./core";

/** Messages the mixer worklet accepts (from the main thread or the decoder worker). */
export type MixerCommand =
  /** `id` comes back in the `loaded` acknowledgement. */
  | { t: "load"; id: number; tracks: MixerTrackConfig[]; lengthFrames: number }
  | { t: "chunk"; index: number; source: number; lap: number; frame: number; data: Float32Array[] }
  | {
      t: "source";
      index: number;
      source: number;
      channels: number;
      clips: ClipRange[];
      offsetDb: number;
      trimDb: number;
      dualMono?: boolean;
    }
  | { t: "play"; countIn?: CountInSpec | null }
  | { t: "pause" }
  | { t: "seek"; frame: number; lap: number }
  /** Loop change; the current lap continues as `base` (a fresh seek base). */
  | { t: "loop"; loop: ClipRange | null; base: number; cache: boolean }
  | { t: "track"; index: number; params: Partial<TrackParams> }
  /** The decoder gave up on a track for now; buffering does not wait for it (until a seek). */
  | { t: "failed"; index: number; failed: boolean }
  | { t: "startFrames"; frames: number }
  /** The song's click pulses (timeline frames, sorted) and levels (SPEC §6.7). */
  | { t: "clickTrack"; frames: Float64Array; levels: Uint8Array }
  | { t: "click"; params: Partial<ClickParams> }
  | { t: "repeatCountIn"; countIn: CountInSpec | null }
  | { t: "workerPort"; port: MessagePort };

/** Mixer worklet → main thread. `loaded` acknowledges the `load` with that `id`. */
export type MixerMessage = MixerEvent | { type: "loaded"; id: number };

/** Mixer worklet → decoder worker: the playhead, and where a loop change took effect. */
export type ToDecoder =
  | { t: "pos"; frame: number; lap: number }
  | { t: "seek"; frame: number; lap: number }
  | {
      t: "retime";
      fromLap: number;
      frame: number;
      base: number;
      loop: ClipRange | null;
      cache: boolean;
    };
