import type { StretchProfile, StretchQuality } from "@bandroom/stretch";
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
  /** How the track follows the practice setting (SPEC §30.3); default: transposed, tonal. */
  stretch?: TrackStretchPolicy;
}

/** A track's practice policy, from its effective instrument (SPEC §30.3, §30.4). */
export interface TrackStretchPolicy {
  /** Follows the transposition (drums and percussion do not by default). */
  transpose: boolean;
  profile: StretchProfile;
  /** Rough fundamental for vocal formant compensation (0 = estimate). */
  voiceBaseHz: number;
  /** Formants kept in place while the pitch moves. */
  formant: boolean;
  /** Formant shift in semitones; a non-zero shift is processed even at 100 % / 0 st. */
  formantShift: number;
}

/** The listener's practice setting for the song (SPEC §30.2). */
export interface EnginePractice {
  /** Timeline frames per output frame (0.25–2). */
  rate: number;
  /** Transposition in semitones, cents included as a fraction. */
  semitones: number;
  quality: StretchQuality;
}

/** How the decoder worker plays a track under a practice setting. */
export interface WorkerStretch {
  rate: number;
  /** 0 for a track kept at its pitch. */
  semitones: number;
  profile: StretchProfile;
  quality: StretchQuality;
  voiceBaseHz: number;
  formant: boolean;
  formantShift: number;
  channels: number;
  /** Muted: produce silence instead of stretching (SPEC §30.5). */
  silent: boolean;
  /** Song length in timeline frames. */
  timelineFrames: number;
}

/** Everything the engine needs to play a song; plain and serializable. */
export interface SongTimeline {
  tracks: EngineTrack[];
  lengthFrames: number;
  /**
   * The transport runs past `lengthFrames` until stopped (SPEC §9: a song without playable
   * tracks plays its click until Stop). Omitted = false.
   */
  openEnd?: boolean;
}

export function clipRanges(clips: EngineClip[]): ClipRange[] {
  return clips.map((c) => ({ start: c.startFrame, end: c.startFrame + c.lengthFrames }));
}

export interface WorkerTrackSpec {
  index: number;
  source: number;
  clips: EngineClip[];
  /** Played through the stretcher (or silenced) under a practice setting; else as is. */
  stretch?: WorkerStretch | null;
}

/** Main thread → decoder worker. */
export type WorkerCommand =
  | { t: "init"; port: MessagePort; cacheBytes: number; windowFrames: number }
  | {
      t: "load";
      /** Load id, acknowledged by the mixer (`loaded`). */
      id: number;
      tracks: WorkerTrackSpec[];
      /** In playback frames (the timeline length / the practice rate). */
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
      stretch?: WorkerStretch | null;
    }
  | { t: "unload" };

/** Decoder worker → main thread. */
export type WorkerEvent =
  { t: "buffer"; ahead: number[] } | { t: "error"; index: number; message: string };
