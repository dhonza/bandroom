import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeWav } from "./wavWriter";

describe("writeWav", () => {
  it("writes a valid header, extra chunks and pad bytes", async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wav-")), "t.wav");
    await writeWav(file, {
      sampleRate: 8000,
      channels: 1,
      format: "s16",
      frames: 3,
      sample: (f) => (f === 1 ? 1 : 0),
      extraChunks: [{ id: "abcd", data: Buffer.from([7]) }],
    });
    const b = await fs.readFile(file);
    expect(b.toString("ascii", 0, 4)).toBe("RIFF");
    expect(b.readUInt32LE(4)).toBe(b.length - 8);
    expect(b.toString("ascii", 36, 40)).toBe("abcd");
    expect(b.readUInt32LE(40)).toBe(1);
    expect(b.toString("ascii", 46, 50)).toBe("data"); // 44 + 1 byte + pad
    expect(b.readInt16LE(56)).toBe(32767);
  });
});
