import { DEFAULT_TOOLS, ffmpegArgs, runTool, type ToolPaths } from "./tools";

export const DUAL_MONO_THRESHOLD_DB = -90;

/**
 * Dual-mono detection (SPEC §5.3 step 3): peak of L−R below −90 dBFS. Uses a float pipeline so
 * integer rounding cannot produce false differences.
 */
export async function detectDualMono(
  file: string,
  channels: number,
  tools = DEFAULT_TOOLS,
  signal?: AbortSignal,
): Promise<boolean> {
  if (channels !== 2) return false;
  // Holder object: assigned inside the stderr callback (TS cannot see that for a plain `let`).
  const peak: { db: number | null } = { db: null };
  await runTool(
    tools.ffmpeg,
    ffmpegArgs(
      "-i",
      file,
      "-map",
      "0:a:0",
      "-af",
      "aformat=sample_fmts=dbl,pan=mono|c0=c0-c1,astats=measure_perchannel=none:measure_overall=Peak_level",
      "-f",
      "null",
      "-",
    ),
    {
      signal,
      onStderrLine: (l) => {
        const m = /Peak level dB:\s*(-?inf|-?[\d.]+)/.exec(l);
        if (m?.[1]) peak.db = m[1].includes("inf") ? -Infinity : Number(m[1]);
      },
    },
  );
  if (peak.db === null) throw new Error("astats did not report a peak level");
  return peak.db < DUAL_MONO_THRESHOLD_DB;
}

/**
 * MD5 of the decoded audio samples (SPEC §5.3 step 4 verification), normalized to 32-bit signed
 * PCM so sources and FLAC variants of different sample formats compare equal. `leftOnly` compares
 * a mono (dual-mono) FLAC against the source's first channel.
 */
export async function audioMd5(
  file: string,
  opts: { leftOnly?: boolean; signal?: AbortSignal } = {},
  tools = DEFAULT_TOOLS,
): Promise<string> {
  const { stdout } = await runTool(
    tools.ffmpeg,
    ffmpegArgs(
      "-i",
      file,
      "-map",
      "0:a:0",
      ...(opts.leftOnly ? ["-af", "pan=mono|c0=c0"] : []),
      "-c:a",
      "pcm_s32le",
      "-f",
      "md5",
      "-",
    ),
    { captureStdout: true, signal: opts.signal },
  );
  const m = /MD5=([0-9a-f]{32})/.exec(stdout);
  if (!m?.[1]) throw new Error("ffmpeg did not output an MD5");
  return m[1];
}

export interface Loudness {
  integratedLufs: number | null;
  lra: number | null;
  truePeakDbtp: number | null;
}

/** EBU R128 loudness via `ebur128=peak=true` (SPEC §5.3 step 9). */
export async function measureLoudness(
  file: string,
  tools: ToolPaths = DEFAULT_TOOLS,
  signal?: AbortSignal,
): Promise<Loudness> {
  const lines: string[] = [];
  await runTool(
    tools.ffmpeg,
    ffmpegArgs("-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"),
    {
      signal,
      onStderrLine: (l) => lines.push(l),
    },
  );
  return parseEbur128Summary(lines);
}

export function parseEbur128Summary(lines: string[]): Loudness {
  const start = lines.findLastIndex((l) => l.includes("Summary:"));
  const summary = start >= 0 ? lines.slice(start) : [];
  const num = (re: RegExp): number | null => {
    for (const l of summary) {
      const m = re.exec(l);
      if (m?.[1]) return m[1].includes("inf") ? null : Number(m[1]);
    }
    return null;
  };
  return {
    integratedLufs: num(/^\s*I:\s*(-?inf|-?[\d.]+) LUFS/),
    lra: num(/^\s*LRA:\s*(-?inf|-?[\d.]+) LU\b/),
    truePeakDbtp: num(/^\s*Peak:\s*(-?inf|-?[\d.]+) dBFS/),
  };
}
