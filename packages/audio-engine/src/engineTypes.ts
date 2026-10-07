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
