import type { ClipRange, MixerTrackConfig } from "./mixer/core";

/** One playable file of a version (SPEC §5.3 variants). */
export interface EngineVariant {
  kind: "opus" | "flac";
  /** Blob hash; the cache key across songs. */
  hash: string;
  url: string;
  /** Seek index JSON (`[sample, byte]` pairs); null disables Range seeking. */
  seekIndexUrl: string | null;
  channels: number;
  /**
   * A stereo upload with L = R stored as one channel: it pans like stereo (balance law, unity at
   * centre) rather than with the mono equal-power law (SPEC §6.6). Omitted = false.
   */
  dualMono?: boolean;
  /** Opus: pre-skip at 48 kHz; FLAC: 0. */
  preSkip: number;
  /** Source frames: Opus decodable samples at 48 kHz, FLAC frames at `sampleRate`. */
  totalFrames: number;
  sampleRate: number;
}

/**
 * A clip on the timeline (SPEC §6.3). v1 has one clip per track: the listened version at its
 * `offsetSamples`. Source frame `sourceOffsetFrame + (t − startFrame)` plays at timeline frame t.
 */
export interface EngineClip {
  startFrame: number;
  sourceOffsetFrame: number;
  lengthFrames: number;
  variant: EngineVariant;
}

export interface EngineTrack {
  id: string;
  clips: EngineClip[];
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Gain of the playing version in dB, before the fader (SPEC §25.6); 0 when omitted. */
  trimDb?: number;
}

/** Everything the engine needs to play a song; plain and serializable. */
export interface SongTimeline {
  tracks: EngineTrack[];
  lengthFrames: number;
}

export function clipRanges(clips: EngineClip[]): ClipRange[] {
  return clips.map((c) => ({ start: c.startFrame, end: c.startFrame + c.lengthFrames }));
}

export interface WorkerTrackSpec {
  index: number;
  source: number;
  clips: EngineClip[];
}

/** Main thread → decoder worker. */
export type WorkerCommand =
  | { t: "init"; port: MessagePort; cacheBytes: number; windowFrames: number }
  | {
      t: "load";
      /** Load id, acknowledged by the mixer (`loaded`). */
      id: number;
      tracks: WorkerTrackSpec[];
      lengthFrames: number;
      mixer: MixerTrackConfig[];
    }
  | {
      t: "source";
      index: number;
      source: number;
      clips: EngineClip[];
      offsetDb: number;
      trimDb: number;
    }
  | { t: "unload" };

/** Decoder worker → main thread. */
export type WorkerEvent =
  { t: "buffer"; ahead: number[] } | { t: "error"; index: number; message: string };
