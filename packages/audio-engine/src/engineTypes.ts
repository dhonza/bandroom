import type { TakeEndReason } from "./mixer/capture";

export type { RecordingLatency } from "./record/placement";

/** Public types of the rehearse-mode engine (re-exported from `engine.ts`). */

/** `error`: the AudioContext or the worklet/worker failed to start; the next `init()` retries. */
export type EngineState =
  "idle" | "loading" | "stopped" | "buffering" | "playing" | "interrupted" | "error";

export interface TrackState {
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
}

export interface EngineEvents {
  state: EngineState;
  /** Peak per track id (post fader, linear) and the master pair, ~20 Hz. */
  meters: { tracks: Record<string, number>; master: [number, number] };
  underrun: { trackId: string; frames: number };
  /** Seconds buffered ahead per track id, ~4 Hz. */
  buffer: Record<string, number>;
  error: { trackId: string; message: string };
  ended: undefined;
  /** Recording (SPEC §9): off, armed (input connected and metered) or recording. */
  recording: RecordingState;
  /**
   * While armed, ~20 Hz: the input peak per channel (linear; ≥ {@link CLIP_LEVEL} is clipping)
   * and the frames recorded so far.
   */
  input: { peaks: [number, number]; recFrames: number };
  /** A take ended (Stop, or by itself: max length, interruption, input gone). */
  take: RecordedTake;
}

export type RecordingState = "off" | "armed" | "recording";

/** Input peak counted as clipping (the meter's clip indicator). */
export const CLIP_LEVEL = 0.999;

/** `Engine.armRecording` (SPEC §9). */
export interface RecordArmOptions {
  /** The microphone (`getUserMedia`, processing off); the engine does not stop its tracks. */
  stream: MediaStream;
  /** 1 = mono (a stereo input is mixed down), 2 = stereo. */
  channels: 1 | 2;
  /**
   * The take port (transferred to the mixer worklet): it receives `TakeMessage`s and its other
   * end returns each chunk's buffer with `TakeFree`.
   */
  port: MessagePort;
  /** Longest take in timeline frames; the take ends there (`maxLength`). */
  maxFrames: number;
  /** Chunk buffers in the pool (default 48, about 4 s of slack for the writer). */
  poolChunks?: number;
  /** Input gain in dB (digital, before metering and writing; default 0). */
  gainDb?: number;
}

/** What a take was (SPEC §9); the audio itself went to the take port. */
export interface RecordedTake {
  /** Timeline frame (48 kHz) of the take's first frame as captured; −1 when nothing was. */
  startFrame: number;
  /** Frames in the take, gaps included. */
  frames: number;
  channels: number;
  /** Frames lost to a full pool (written as silence). */
  gapFrames: number;
  endedBy: TakeEndReason;
  /**
   * The worklet confirmed the end (its last chunk and `take.end` went to the port). False when
   * the context went away first: the take then ends at the last chunk the writer received.
   */
  confirmed: boolean;
}

export interface EngineOptions {
  /** URL of the bundled decoder worker (`worker/entry.ts`). */
  workerUrl: string | URL;
  /** URL of the bundled AudioWorklet module (`mixer/processor.ts`). */
  workletUrl: string | URL;
  /** Compressed-byte cache across songs (SPEC §6.4: 256 MB phones, 1 GB desktop). */
  cacheBytes: number;
  /** Decode-ahead window (SPEC §6.4, 2–10 s). */
  windowSeconds?: number;
  /** Buffered audio needed before playback starts (SPEC §6.4: ~3 s after load). */
  startSeconds?: number;
  /** Stopped this long, the AudioContext is suspended to save battery (default 30 s). */
  idleSuspendMs?: number;
}

/** The count-in shown as a countdown ("2… 3… 4…", SPEC §6.7). */
export interface CountInState {
  /** 1-based click being played. */
  beat: number;
  clicks: number;
}
