import type { CountInSpec } from "./click";
import type {
  ClickParams,
  ClipRange,
  MixerEvent,
  MixerTrackConfig,
  TakeEndReason,
  TrackParams,
} from "./core";

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
  | { t: "workerPort"; port: MessagePort }
  /** Open end (SPEC §9): the transport runs past the song length until stopped. */
  | { t: "openEnd"; on: boolean }
  /**
   * Recording (SPEC §9): the input is connected. Chunks go to `port` (the take writer's end
   * replies with `TakeFree`); `buffers` are the initial pool (transferred).
   */
  | {
      t: "recArm";
      port: MessagePort;
      channels: number;
      maxFrames: number;
      buffers: Float32Array[];
    }
  | { t: "recStart" }
  | { t: "recStop"; reason: TakeEndReason }
  | { t: "recDisarm" };

/** Mixer worklet → main thread. `loaded` acknowledges the `load` with that `id`. */
export type MixerMessage = MixerEvent | { type: "loaded"; id: number };

/** Mixer worklet → decoder worker: the playhead, and where a loop change took effect. */
/**
 * Mixer → decoder worker. `load` is the id of the song load the mixer had when it sent the
 * message: messages about an earlier song still in flight when the worker loads the next one are
 * dropped (a late playhead report would otherwise move the new song's decoding to the old
 * position, and the mixer would wait for data at the start forever).
 */
export type ToDecoder =
  | { t: "pos"; load: number; frame: number; lap: number }
  | { t: "seek"; load: number; frame: number; lap: number }
  | {
      t: "retime";
      load: number;
      fromLap: number;
      frame: number;
      base: number;
      loop: ClipRange | null;
      cache: boolean;
    };
