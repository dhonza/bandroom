import { dbToGain } from "@bandroom/shared/audio";
import { WINDOWED_OPUS_FRAMES, type EngineClip, type EngineVariant, type FadeShape } from "./types";

/**
 * Clip gain, fades and channel layout (SPEC §24.5). Pure functions over plain numbers; the ones
 * that touch sample buffers are allocation-free.
 */

const HALF_PI = Math.PI / 2;

/**
 * Fade-in gain of a fade `len` frames long at frame `k` of it (0 ≤ k < len), sampled at the frame
 * centre: linear `(k + ½) / len`, equal-power `sin(π/2 · (k + ½) / len)`. The matching fade-out is
 * the same curve mirrored (`1 −` resp. `cos`), so a linear fade-out and fade-in over the same
 * frames sum to exactly 1 and an equal-power pair keeps the power.
 */
export function fadeInGain(shape: FadeShape, k: number, len: number): number {
  const x = (k + 0.5) / len;
  return shape === "linear" ? x : Math.sin(HALF_PI * x);
}

/** Fade-out gain at frame `k` of a fade `len` frames long (see {@link fadeInGain}). */
export function fadeOutGain(shape: FadeShape, k: number, len: number): number {
  const x = (k + 0.5) / len;
  return shape === "linear" ? 1 - x : Math.cos(HALF_PI * x);
}

/**
 * The clip's gain at timeline frame `frame` (inside the clip): its gain in dB times the fade-in
 * over its first `fadeInFrames` and the fade-out over its last `fadeOutFrames` (both apply where
 * they overlap). 0 outside the clip.
 */
export function clipEnvelope(clip: EngineClip, frame: number): number {
  const k = frame - clip.startFrame;
  if (k < 0 || k >= clip.lengthFrames) return 0;
  let g = dbToGain(clip.gainDb ?? 0);
  const fin = clip.fadeInFrames ?? 0;
  if (k < fin) g *= fadeInGain(clip.fadeInShape ?? "linear", k, fin);
  const fout = clip.fadeOutFrames ?? 0;
  const fromOut = k - (clip.lengthFrames - fout);
  if (fout > 0 && fromOut >= 0) g *= fadeOutGain(clip.fadeOutShape ?? "linear", fromOut, fout);
  return g;
}

/** True when the envelope is exactly 1 over `[from, to)` (no gain, no fade in that range). */
export function unityEnvelope(clip: EngineClip, from: number, to: number): boolean {
  if ((clip.gainDb ?? 0) !== 0) return false;
  const fin = clip.fadeInFrames ?? 0;
  if (fin > 0 && from < clip.startFrame + fin) return false;
  const fout = clip.fadeOutFrames ?? 0;
  return !(fout > 0 && to > clip.startFrame + clip.lengthFrames - fout);
}

/** Multiplies `n` frames of `data` from `offset` (timeline frame `frame`) by the envelope. */
export function applyEnvelope(
  clip: EngineClip,
  frame: number,
  data: readonly Float32Array[],
  offset: number,
  n: number,
): void {
  for (let i = 0; i < n; i++) {
    const g = clipEnvelope(clip, frame + i);
    if (g === 1) continue;
    for (let c = 0; c < data.length; c++) {
      const d = data[c];
      if (d) d[offset + i] = (d[offset + i] ?? 0) * g;
    }
  }
}

/** A track's channel layout: what the mixer gets for all its clips together. */
export interface TrackLayout {
  /** 1 or 2. */
  channels: number;
  /** One stored channel panned with the stereo law (every clip is dual-mono). */
  dualMono: boolean;
}

/**
 * The layout of a track (SPEC §24.5): mono only when every clip is (plain mono, or every clip
 * dual-mono); any stereo clip, or plain mono mixed with dual-mono, makes it stereo, and the
 * one-channel clips are up-mixed by {@link upmixGain}. No clips: stereo.
 */
export function trackLayout(clips: readonly EngineClip[]): TrackLayout {
  if (clips.length === 0) return { channels: 2, dualMono: false };
  let stereo = false;
  let dual = 0;
  for (const c of clips) {
    if (c.variant.channels >= 2) stereo = true;
    else if (c.variant.dualMono) dual++;
  }
  if (stereo || (dual > 0 && dual < clips.length)) return { channels: 2, dualMono: false };
  return { channels: 1, dualMono: dual > 0 };
}

/**
 * Gain of a one-channel clip copied to both sides of a stereo track: dual-mono at unity (it pans
 * with the stereo law anyway), plain mono at −3 dB (√½), the mono pan law's centre gain, so a
 * clip sounds the same as on a mono track. 1 when no up-mix happens.
 */
export function upmixGain(clip: EngineClip, layout: TrackLayout): number {
  if (layout.channels === 1 || clip.variant.channels >= 2 || clip.variant.dualMono) return 1;
  return Math.SQRT1_2;
}

/**
 * Adds `n` frames of a clip's decoded `src` (from `srcOffset`, timeline frame `frame`) times its
 * envelope and up-mix gain into `out` (track layout) from `outOffset`. Allocation-free.
 */
export function addClip(
  out: readonly Float32Array[],
  outOffset: number,
  src: readonly Float32Array[],
  srcOffset: number,
  n: number,
  clip: EngineClip,
  frame: number,
  upmix: number,
): void {
  const s0 = src[0];
  if (!s0) return;
  const s1 = src[1] ?? s0;
  const o0 = out[0];
  const o1 = out[1];
  if (!o0) return;
  const unity = upmix === 1 && unityEnvelope(clip, frame, frame + n);
  for (let i = 0; i < n; i++) {
    const g = unity ? 1 : clipEnvelope(clip, frame + i) * upmix;
    const j = srcOffset + i;
    const o = outOffset + i;
    o0[o] = (o0[o] ?? 0) + (s0[j] ?? 0) * g;
    if (o1) o1[o] = (o1[o] ?? 0) + (s1[j] ?? 0) * g;
  }
}

/** How a variant's file is fetched (see `EngineVariant.fetch`). */
export function fetchModeOf(v: EngineVariant): "whole" | "window" {
  return v.fetch ?? (v.kind === "opus" ? "whole" : "window");
}

/** `window` for Opus versions longer than {@link WINDOWED_OPUS_FRAMES} (SPEC §24.5). */
export function defaultFetch(
  v: Pick<EngineVariant, "kind" | "totalFrames">,
): "whole" | "window" | undefined {
  return v.kind === "opus" && v.totalFrames > WINDOWED_OPUS_FRAMES ? "window" : undefined;
}
