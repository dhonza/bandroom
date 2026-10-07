import { DEFAULT_TOOLS, runTool, type ToolPaths } from "./tools";

/**
 * FLAC seek index (SPEC §5.3 step 7): [sample position, byte offset] of frame starts, at most
 * ~1 s apart, from ffprobe packet positions (the FLAC demuxer reports exact frame offsets).
 */
export async function flacSeekIndex(
  file: string,
  sampleRate: number,
  tools: ToolPaths = DEFAULT_TOOLS,
  signal?: AbortSignal,
): Promise<[number, number][]> {
  const { stdout } = await runTool(
    tools.ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "packet=pts,pos",
      "-of",
      "csv=p=0",
      file,
    ],
    { captureStdout: true, signal },
  );
  const index: [number, number][] = [];
  let last = -Infinity;
  for (const line of stdout.split("\n")) {
    const [ptsS, posS] = line.trim().split(",");
    if (!ptsS || !posS) continue;
    const pts = Number(ptsS);
    const pos = Number(posS);
    if (!Number.isFinite(pts) || !Number.isFinite(pos)) continue;
    if (pts - last >= sampleRate || index.length === 0) {
      index.push([pts, pos]);
      last = pts;
    }
  }
  return index;
}
