import { DEFAULT_TOOLS, ffmpegArgs, runTool, type ToolPaths } from "./tools";

const resamplerCache = new Map<string, Promise<string>>();

/**
 * Resampler to 48 kHz. SPEC §5.3 asks for soxr high quality (present in the Docker image and in
 * CI); some ffmpeg builds (e.g. Homebrew) lack libsoxr, so fall back to swresample with a long
 * filter, which keeps the same zero-delay alignment.
 */
export function resampleFilter(tools: ToolPaths = DEFAULT_TOOLS): Promise<string> {
  let p = resamplerCache.get(tools.ffmpeg);
  if (!p) {
    p = runTool(
      tools.ffmpeg,
      ffmpegArgs(
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=mono",
        "-t",
        "0.01",
        "-af",
        "aresample=48000:resampler=soxr",
        "-f",
        "null",
        "-",
      ),
      { nice: false },
    ).then(
      () => "aresample=48000:resampler=soxr:precision=28",
      () => {
        console.warn(
          "[bandroom] ffmpeg has no libsoxr; using swresample (filter_size=64) for 48 kHz resampling",
        );
        return "aresample=48000:filter_size=64:phase_shift=10:cutoff=0.97";
      },
    );
    resamplerCache.set(tools.ffmpeg, p);
  }
  return p;
}

const STRIP = ["-map", "0:a:0", "-map_metadata", "-1", "-vn"];

/**
 * FLAC storage variant (SPEC §5.3 step 4). Integer sources keep their bit depth (lossless,
 * verified by MD5 afterwards). Float or >24-bit sources become 24-bit with triangular dither
 * (`nearLossless`), used only for lossless playback while the original is kept.
 */
export async function encodeFlac(
  src: string,
  dest: string,
  opts: { bitDepth: number; nearLossless: boolean; mono: boolean; signal?: AbortSignal },
  tools: ToolPaths = DEFAULT_TOOLS,
): Promise<{ bitDepth: number }> {
  const filters: string[] = [];
  if (opts.mono) filters.push("pan=mono|c0=c0");
  let fmt: string[];
  let bitDepth: number;
  if (opts.nearLossless || opts.bitDepth > 24) {
    filters.push("aresample=osf=s32:dither_method=triangular");
    fmt = ["-sample_fmt", "s32", "-bits_per_raw_sample", "24"];
    bitDepth = 24;
  } else if (opts.bitDepth > 16) {
    fmt = ["-sample_fmt", "s32", "-bits_per_raw_sample", String(opts.bitDepth)];
    bitDepth = opts.bitDepth;
  } else {
    fmt = ["-sample_fmt", "s16"];
    bitDepth = 16;
  }
  await runTool(
    tools.ffmpeg,
    ffmpegArgs(
      "-i",
      src,
      ...STRIP,
      ...(filters.length ? ["-af", filters.join(",")] : []),
      "-c:a",
      "flac",
      "-compression_level",
      "8",
      ...fmt,
      "-f",
      "flac",
      dest,
    ),
    { signal: opts.signal },
  );
  return { bitDepth };
}

/**
 * Opus playback variant (SPEC §5.3 step 5): 48 kHz via soxr, Ogg, libopus, `-application audio`,
 * VBR. More than two channels are downmixed to stereo.
 */
export async function encodeOpus(
  src: string,
  dest: string,
  opts: { bitrateKbps: number; channels: 1 | 2; signal?: AbortSignal },
  tools: ToolPaths = DEFAULT_TOOLS,
): Promise<void> {
  const filters = [...(opts.channels === 1 ? ["pan=mono|c0=c0"] : []), await resampleFilter(tools)];
  await runTool(
    tools.ffmpeg,
    ffmpegArgs(
      "-i",
      src,
      ...STRIP,
      "-af",
      filters.join(","),
      "-ac",
      String(opts.channels),
      "-c:a",
      "libopus",
      "-application",
      "audio",
      "-vbr",
      "on",
      "-b:a",
      `${opts.bitrateKbps}k`,
      "-f",
      "ogg",
      dest,
    ),
    { signal: opts.signal },
  );
}
