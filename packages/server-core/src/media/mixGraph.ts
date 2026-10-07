import path from "node:path";
import { dbToGain, panGains } from "@bandroom/shared";
import { measureLoudness, type Loudness } from "./analysis";
import { resampleFilter } from "./encode";
import { ffmpegArgs, runTool, type ToolPaths } from "./tools";

/**
 * Server-side mix of several track versions with ffmpeg (SPEC §5.5): the graph pieces and the
 * render the bounce (`audio.bounce`) builds on. The pan laws and gains follow the browser engine
 * (SPEC §6.6, §25.6), so a rendered mix sounds like the mixer.
 */

/** Sums above this true peak get the limiter (SPEC §5.5: −1 dBTP). */
export const MIX_TRUE_PEAK_LIMIT_DB = -1;

export interface MixInput {
  path: string;
  /** Linear gain (fader × version gain). */
  gain: number;
  /** −1 … 1. */
  pan: number;
  /** Channels of the stored file: 1 for mono and dual-mono sources, else 2. */
  channels: 1 | 2;
  /**
   * Pan law (SPEC §6.6): `mono` is equal power (−3 dB per side at centre), `stereo` the balance
   * law (unity at centre). Dual-mono sources are stored as one channel but use `stereo`.
   */
  law: "mono" | "stereo";
  /** Timeline position in samples at 48 kHz. */
  offsetSamples: number;
}

/** The pan law of a source: true mono pans with equal power, dual-mono and stereo by balance. */
export function panLaw(probe: { channels: number; dualMono?: boolean } | null): "mono" | "stereo" {
  return probe?.channels === 1 && !probe.dualMono ? "mono" : "stereo";
}

/**
 * Channels of the file the mix reads: the probe describes the upload, but a dual-mono upload's
 * `flac` and `opus` hold one channel (SPEC §5.2); its kept `original` still has two.
 */
export function mixChannels(
  probe: { channels: number; dualMono?: boolean } | null,
  variant: string,
): 1 | 2 {
  if (probe?.channels === 1) return 1;
  return probe?.dualMono && variant !== "original" ? 1 : 2;
}

/**
 * Linear gain of one input from two dB values (SPEC §25.6), e.g. the fader and the version's own
 * gain: `version gain × fader gain`.
 */
export function mixGain(faderDb: number, versionGainDb: number): number {
  return dbToGain(faderDb) * dbToGain(versionGainDb);
}

/**
 * Builds the ffmpeg filter graph: per input resample → pan (by its law) → gain → delay by the
 * version's timeline offset; then `amix` without normalization.
 */
export function mixdownFilter(inputs: readonly MixInput[], resample: string): string {
  const chains = inputs.map((inp, i) => {
    const g = panGains(inp.pan, inp.law);
    // A one-channel file (mono or dual-mono) feeds both sides from its only channel.
    const right = inp.channels === 1 ? "c0" : "c1";
    const pan = `pan=stereo|c0=${(g.left * inp.gain).toFixed(6)}*c0|c1=${(g.right * inp.gain).toFixed(6)}*${right}`;
    const delay = inp.offsetSamples > 0 ? `,adelay=delays=${inp.offsetSamples}S:all=1` : "";
    return `[${i}:a]${resample},${pan}${delay}[a${i}]`;
  });
  const labels = inputs.map((_, i) => `[a${i}]`).join("");
  const mix =
    inputs.length === 1
      ? `${labels}anull[m]`
      : `${labels}amix=inputs=${inputs.length}:normalize=0:duration=longest[m]`;
  return [...chains, mix].join(";");
}

export interface RenderedMix {
  /** 48 kHz stereo float WAV in `tmpDir`. */
  path: string;
  /** Whether the limiter ran (the sum's true peak was above −1 dBTP). */
  limited: boolean;
  loudness: Loudness;
}

/**
 * Renders the inputs into one 48 kHz stereo WAV (one streaming ffmpeg run), then applies a
 * limiter only when the sum clips (true peak above −1 dBTP).
 */
export async function renderMix(
  ctx: { tools: ToolPaths; tmpDir: string; signal?: AbortSignal },
  inputs: readonly MixInput[],
): Promise<RenderedMix> {
  if (inputs.length === 0) throw new Error("renderMix needs at least one input");
  const { tools, signal } = ctx;
  const wav = path.join(ctx.tmpDir, "mix.wav");
  await runTool(
    tools.ffmpeg,
    ffmpegArgs(
      ...inputs.flatMap((i) => ["-i", i.path]),
      "-filter_complex",
      mixdownFilter(inputs, await resampleFilter(tools)),
      "-map",
      "[m]",
      "-ar",
      "48000",
      "-c:a",
      "pcm_f32le",
      wav,
    ),
    { signal },
  );
  const loudness = await measureLoudness(wav, tools, signal);
  if (loudness.truePeakDbtp === null || loudness.truePeakDbtp <= MIX_TRUE_PEAK_LIMIT_DB)
    return { path: wav, limited: false, loudness };
  const out = path.join(ctx.tmpDir, "mix-limited.wav");
  // alimiter works on sample peaks: aim at −1.5 dBFS to keep inter-sample peaks under −1 dBTP.
  await runTool(
    tools.ffmpeg,
    ffmpegArgs(
      "-i",
      wav,
      "-af",
      "alimiter=limit=0.841:level=false:attack=5:release=50",
      "-c:a",
      "pcm_f32le",
      out,
    ),
    { signal },
  );
  return { path: out, limited: true, loudness: await measureLoudness(out, tools, signal) };
}
