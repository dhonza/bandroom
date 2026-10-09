import { dbToGain, type EditClip } from "@bandroom/shared";

/**
 * The ffmpeg pieces of an edit render (SPEC §24.10): one input per clip, seeked close to the
 * clip and trimmed by absolute sample index, gain and the fade envelopes exactly as the engine
 * plays them (`packages/audio-engine/src/clips.ts`), the channel up-mix rules of the engine, the
 * clip's timeline offset, and a plain sum. Pure; `render.ts` runs it.
 */

export const RENDER_RATE = 48_000;

/** A clip's source file as the render reads it. */
export interface RenderSource {
  path: string;
  /** Sample rate of the file (Opus decodes at 48 kHz). */
  sampleRate: number;
  /** Channels of the file read: 1 (mono, or a dual-mono FLAC/Opus) or 2. */
  channels: 1 | 2;
  /** A true mono source (not dual-mono): −3 dB when up-mixed onto a stereo output. */
  plainMono: boolean;
}

export type RenderClip = Pick<
  EditClip,
  | "sourceStartFrame"
  | "startFrame"
  | "lengthFrames"
  | "gainDb"
  | "fadeInFrames"
  | "fadeOutFrames"
  | "fadeInShape"
  | "fadeOutShape"
>;

export interface RenderInput {
  source: RenderSource;
  clip: RenderClip;
}

/**
 * Output channels (SPEC §24.5, as the engine's `trackLayout`): mono only when every clip is a
 * true mono file; any stereo or dual-mono clip makes a stereo output (a dual-mono-only output
 * stays two equal channels, so the ingest stores it as dual-mono and it pans the same).
 */
export function renderChannels(inputs: readonly RenderInput[]): 1 | 2 {
  return inputs.length > 0 && inputs.every((i) => i.source.plainMono) ? 1 : 2;
}

/** The output's span on the timeline: from the first clip's start to the last clip's end. */
export function renderSpan(clips: readonly RenderClip[]): { start: number; length: number } {
  if (clips.length === 0) throw new Error("A render needs at least one clip");
  const start = Math.min(...clips.map((c) => c.startFrame));
  const end = Math.max(...clips.map((c) => c.startFrame + c.lengthFrames));
  return { start, length: end - start };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Source samples a seek may land on: positions that are whole 48 kHz frames (so the resampled
 * stream stays on the timeline's grid) and whole microseconds (so ffmpeg's seek is exact).
 */
export function seekStep(sampleRate: number): number {
  const a = sampleRate / gcd(sampleRate, RENDER_RATE);
  const b = sampleRate / gcd(sampleRate, 1_000_000);
  return (a * b) / gcd(a, b);
}

/** Context decoded before a clip, so the resampler and decoder settle (48 kHz frames). */
export const SEEK_PREROLL = 24_000;

export interface InputPlan {
  /** Where the input is opened: source samples, and seconds for `-ss` (0 = from the start). */
  seekSamples: number;
  seekSec: number;
  /** 48 kHz frames from the seek point to the clip's first frame. */
  trimStart: number;
  /** Seconds to decode after the seek (`-t`), with a margin; the trim ends the clip exactly. */
  durationSec: number;
}

/**
 * Where a clip's input starts (SPEC §24.10): its source start in source samples is
 * `sourceStartFrame × rate / 48 000`; the input opens at a grid point about half a second
 * before, and the clip is trimmed out of the 48 kHz stream by frame index.
 */
export function inputPlan(clip: RenderClip, sampleRate: number): InputPlan {
  const step = seekStep(sampleRate);
  const target = Math.max(0, clip.sourceStartFrame - SEEK_PREROLL);
  const seekSamples = Math.floor((target * sampleRate) / RENDER_RATE / step) * step;
  const seek48 = (seekSamples * RENDER_RATE) / sampleRate;
  const trimStart = clip.sourceStartFrame - seek48;
  return {
    seekSamples,
    seekSec: seekSamples / sampleRate,
    trimStart,
    durationSec: (trimStart + clip.lengthFrames) / RENDER_RATE + 0.5,
  };
}

const num = (x: number) => {
  const s = x.toFixed(12).replace(/0+$/, "");
  return s.endsWith(".") ? `${s}0` : s;
};

/**
 * The clip's gain envelope as an `aeval` expression over the clip's frame index `n` (SPEC
 * §24.5): gain × fade-in over the first `fadeInFrames` × fade-out over the last `fadeOutFrames`,
 * sampled at frame centres (`(k + ½) / len`), linear or sin/cos. Null when the envelope is a
 * constant (then `volume` applies the gain).
 */
export function envelopeExpr(clip: RenderClip, gain: number): string | null {
  const parts: string[] = [];
  const fin = clip.fadeInFrames;
  if (fin > 0) {
    const x = `(n+0.5)/${fin}`;
    const g = clip.fadeInShape === "linear" ? x : `sin(PI/2*${x})`;
    parts.push(`if(lt(n,${fin}),${g},1)`);
  }
  const fout = clip.fadeOutFrames;
  if (fout > 0) {
    const from = clip.lengthFrames - fout;
    const x = `(n-${from}+0.5)/${fout}`;
    const g = clip.fadeOutShape === "linear" ? `(1-${x})` : `cos(PI/2*${x})`;
    parts.push(`if(gte(n,${from}),${g},1)`);
  }
  if (parts.length === 0) return null;
  return `val(ch)*${num(gain)}*${parts.join("*")}`;
}

/** The linear gain of a clip on the output: its gain, and −3 dB for mono up-mixed to stereo. */
export function clipGain(input: RenderInput, outChannels: 1 | 2): number {
  const upmix = outChannels === 2 && input.source.plainMono ? Math.SQRT1_2 : 1;
  return dbToGain(input.clip.gainDb) * upmix;
}

/** ffmpeg input arguments of a clip. */
export function inputArgs(input: RenderInput): string[] {
  const p = inputPlan(input.clip, input.source.sampleRate);
  return [
    ...(p.seekSamples > 0 ? ["-ss", p.seekSec.toFixed(6)] : []),
    "-t",
    p.durationSec.toFixed(6),
    "-i",
    input.source.path,
  ];
}

/**
 * The filter chain of input `i`: resample to 48 kHz (if needed) → trim the clip by frame index →
 * exact length → channels of the output → gain and fades → delay to its place in the output.
 */
export function clipChain(
  input: RenderInput,
  i: number,
  out: { start: number; channels: 1 | 2; resample: string },
): string {
  const { clip, source } = input;
  const p = inputPlan(clip, source.sampleRate);
  const L = clip.lengthFrames;
  const steps: string[] = [];
  if (source.sampleRate !== RENDER_RATE) steps.push(out.resample);
  steps.push(
    `atrim=start_sample=${p.trimStart}:end_sample=${p.trimStart + L}`,
    "asetpts=N/SR/TB",
    `apad=whole_len=${L}`,
    `atrim=end_sample=${L}`,
  );
  if (out.channels === 1) steps.push("pan=mono|c0=c0");
  else steps.push(`pan=stereo|c0=c0|c1=${source.channels === 1 ? "c0" : "c1"}`);
  const gain = clipGain(input, out.channels);
  const env = envelopeExpr(clip, gain);
  if (env !== null) steps.push(`aeval='${env}':c=same`);
  else if (gain !== 1) steps.push(`volume=${num(gain)}`);
  const delay = clip.startFrame - out.start;
  if (delay > 0) steps.push(`adelay=delays=${delay}S:all=1`);
  return `[${i}:a]${steps.join(",")}[c${i}]`;
}

/** The whole graph: every clip's chain, then a plain sum (`normalize=0`) of the exact length. */
export function renderFilter(
  inputs: readonly RenderInput[],
  out: { start: number; length: number; channels: 1 | 2; resample: string },
): string {
  const chains = inputs.map((input, i) => clipChain(input, i, out));
  const labels = inputs.map((_, i) => `[c${i}]`).join("");
  const sum =
    inputs.length === 1
      ? `${labels}anull`
      : `${labels}amix=inputs=${inputs.length}:normalize=0:duration=longest`;
  return [
    ...chains,
    `${sum},apad=whole_len=${out.length},atrim=end_sample=${out.length}[out]`,
  ].join(";");
}
