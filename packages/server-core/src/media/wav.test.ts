import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../testing/tempDir";
import {
  buildWavMeta,
  MAX_WAV_META_BYTES,
  NotRiffWaveError,
  parseWavMeta,
  WavMetaTooLargeError,
} from "./wav";

let tmp: ReturnType<typeof makeTempDir>;
beforeEach(() => {
  tmp = makeTempDir();
});
afterEach(() => {
  tmp.cleanup();
});

function chunk(id: string, payload: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.write(id, 0, "latin1");
  h.writeUInt32LE(payload.length, 4);
  return Buffer.concat([h, payload, Buffer.alloc(payload.length % 2)]);
}

/** A 16-bit mono 48 kHz WAV with an extra `junk` chunk of `junkBytes` before the data. */
async function wavWithJunk(junkBytes: number): Promise<string> {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(48_000, 4);
  fmt.writeUInt32LE(96_000, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const body = Buffer.concat([
    Buffer.from("WAVE"),
    chunk("fmt ", fmt),
    chunk("junk", Buffer.alloc(junkBytes)),
    chunk("data", Buffer.alloc(960)),
  ]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(body.length, 4);
  const file = path.join(tmp.dir, `junk-${String(junkBytes)}.wav`);
  await fs.writeFile(file, Buffer.concat([riff, body]));
  return file;
}

describe("wavmeta size cap (review M6)", () => {
  it("keeps ordinary header chunks", async () => {
    const meta = parseWavMeta(await buildWavMeta(await wavWithJunk(1000)));
    expect(meta.index.chunks.map((c) => c.id)).toEqual(["fmt ", "junk", "data"]);
  });

  it("refuses header chunks above the cap (ingest then skips wavmeta)", async () => {
    const err = await buildWavMeta(await wavWithJunk(MAX_WAV_META_BYTES)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WavMetaTooLargeError);
    expect(err).toBeInstanceOf(NotRiffWaveError);
  });
});
