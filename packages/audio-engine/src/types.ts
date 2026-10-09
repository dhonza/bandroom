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
  /**
   * How the file is fetched (SPEC §24.5): `whole` downloads it progressively and keeps it,
   * `window` reads Range blocks on demand and drops those behind the playhead. Omitted: Opus
   * `whole` (switching to `window` when bigger than its share of the budget), FLAC `window`.
   * Opus versions longer than {@link WINDOWED_OPUS_FRAMES} are read in windows from the start.
   */
  fetch?: "whole" | "window";
}

/** Opus versions longer than this (20 min at 48 kHz) are fetched in windows (SPEC §24.5). */
export const WINDOWED_OPUS_FRAMES = 20 * 60 * 48_000;

/** The shape of a clip's fade: `linear` (gain t, sums to unity across a crossfade) or sin/cos. */
export type FadeShape = "linear" | "equalPower";

/**
 * A clip on the timeline (SPEC §6.3, §24.5): a piece of one version's file. Source frame
 * `sourceOffsetFrame + (t − startFrame)` plays at timeline frame t. Outside edit mode a track has
 * one clip (the listened version at its `offsetSamples`); in edit mode it may have several, from
 * different versions (each clip has its own `variant`), overlapping (they are summed) or with
 * gaps (silence).
 */
export interface EngineClip {
  startFrame: number;
  sourceOffsetFrame: number;
  lengthFrames: number;
  variant: EngineVariant;
  /** Clip gain in dB (default 0). */
  gainDb?: number;
  /** Fade-in over the clip's first frames (default 0 = hard edge). */
  fadeInFrames?: number;
  /** Fade-out over the clip's last frames (default 0 = hard edge). */
  fadeOutFrames?: number;
  /** Default `linear`. */
  fadeInShape?: FadeShape;
  /** Default `linear`. */
  fadeOutShape?: FadeShape;
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

/** The timeline ranges with audio: the union of the clips, sorted and merged. */
export function clipRanges(clips: readonly EngineClip[]): ClipRange[] {
  const sorted = clips
    .filter((c) => c.lengthFrames > 0)
    .map((c) => ({ start: c.startFrame, end: c.startFrame + c.lengthFrames }))
    .sort((a, b) => a.start - b.start);
  const out: ClipRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
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
