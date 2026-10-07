import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * A unique sibling of `file` that keeps its extension (ffmpeg picks the output format from it),
 * e.g. `tone.wav` → `tone.tmp-1234-9f3a0c1e.wav`.
 */
export function tempPathFor(file: string): string {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  return `${base}.tmp-${String(process.pid)}-${randomBytes(4).toString("hex")}${ext}`;
}

/**
 * Writes `file` via a temporary sibling and an atomic rename, so concurrent generators (parallel
 * test files and e2e workers) never see, read or interleave with a half-written fixture.
 */
export async function writeAtomically(
  file: string,
  write: (tmp: string) => Promise<void>,
): Promise<void> {
  const tmp = tempPathFor(file);
  try {
    await write(tmp);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
