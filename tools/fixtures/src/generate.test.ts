import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { tempPathFor, writeAtomically } from "./atomic";
import {
  AIFF_FILE,
  BWF_FILE,
  FLAC_FILE,
  MP3_FILE,
  SMPTE_MIDI_FILE,
  TONE_FILE,
  generateFixtures,
  longFixtures,
  matrix,
} from "./generate";
import { MIDI_FIXTURES } from "./midi";

const exec = promisify(execFile);

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "fixtures-"));
}

/** Decodes a file with ffmpeg; rejects on a truncated or corrupt file. */
async function decodes(file: string): Promise<void> {
  await exec(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-xerror",
    "-i",
    file,
    "-f",
    "null",
    "-",
  ]);
}

describe("tempPathFor", () => {
  it("keeps the extension and is unique", () => {
    const a = tempPathFor("/x/tone.wav");
    expect(a).toMatch(new RegExp(`^/x/tone\\.tmp-${String(process.pid)}-[0-9a-f]{8}\\.wav$`));
    expect(tempPathFor("/x/tone.wav")).not.toBe(a);
  });
});

describe("writeAtomically", () => {
  it("removes the temporary file when writing fails", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "a.wav");
    await expect(
      writeAtomically(target, async (tmp) => {
        await fs.writeFile(tmp, "partial");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

describe("generateFixtures", () => {
  it("can run concurrently into the same directory", { timeout: 180_000 }, async () => {
    const dir = await tempDir();
    await Promise.all([generateFixtures({ dir }), generateFixtures({ dir })]);

    const names = await fs.readdir(dir);
    expect(names.filter((n) => n.includes(".tmp-"))).toEqual([]);
    const expected = [
      ...[...matrix(), ...longFixtures()].map((f) => f.file),
      BWF_FILE(),
      TONE_FILE(),
      MP3_FILE(),
      FLAC_FILE(),
      AIFF_FILE(),
      SMPTE_MIDI_FILE(),
      ...MIDI_FIXTURES().map((f) => f.name),
    ].map((f) => path.basename(f));
    expect(names.sort()).toEqual([...new Set(expected)].sort());

    for (const f of [...matrix(), ...longFixtures()]) {
      const b = await fs.readFile(path.join(dir, path.basename(f.file)));
      expect(b.toString("ascii", 0, 4)).toBe("RIFF");
      expect(b.readUInt32LE(4)).toBe(b.length - 8);
    }
    for (const f of [MP3_FILE(), FLAC_FILE(), AIFF_FILE()]) {
      await decodes(path.join(dir, path.basename(f)));
    }
    for (const f of MIDI_FIXTURES()) {
      expect(new Uint8Array(await fs.readFile(path.join(dir, f.name)))).toEqual(
        new Uint8Array(f.bytes),
      );
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
});
