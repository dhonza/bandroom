import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clickSamples, synthClick } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { floatWavHeader, renderClickBlock, writeClickWav } from "./clickTrack";

describe("bounce click track (SPEC §5.5, §6.7)", () => {
  const samples = clickSamples("woodblock");
  const pulses = {
    frames: Float64Array.from([10, 500, 900]),
    levels: Uint8Array.from([0, 1, 2]),
  };

  /** The whole track in one block. */
  function whole(len: number, accent = true): Float32Array {
    const out = new Float32Array(len);
    renderClickBlock(out, 0, pulses, samples, accent, 0);
    return out;
  }

  it("puts each pulse's sample at its frame; overlapping clicks add up", () => {
    const out = whole(3000);
    expect(out[10]).toBe(0); // the attack starts at 0
    for (let j = 0; j < 400; j++) expect(out[10 + j]).toBeCloseTo((samples[0][j] ?? 0) + 0, 7);
    // 500 overlaps the end of the first click (1440 samples long).
    expect(out[600]).toBeCloseTo((samples[0][590] ?? 0) + (samples[1][100] ?? 0), 7);
    expect(out[1000]).toBeCloseTo(
      (samples[0][990] ?? 0) + (samples[1][500] ?? 0) + (samples[2][100] ?? 0),
      7,
    );
    // Accent off: the downbeat plays the beat sample.
    expect(whole(100, false)[50]).toBeCloseTo(samples[1][40] ?? 0, 7);
  });

  it("renders the same in small blocks as in one", () => {
    const ref = whole(3000);
    const out = new Float32Array(3000);
    const block = new Float32Array(128);
    let first = 0;
    for (let from = 0; from < 3000; from += 128) {
      const b = block.subarray(0, Math.min(128, 3000 - from));
      first = renderClickBlock(b, from, pulses, samples, true, first);
      out.set(b, from);
    }
    expect(first).toBe(3);
    expect(Array.from(out)).toEqual(Array.from(ref));
  });

  it("writes a mono float WAV at 48 kHz, streamed in blocks", async () => {
    expect(floatWavHeader(10).readUInt32LE(40)).toBe(40);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "click-"));
    try {
      const file = path.join(dir, "click.wav");
      const lengthFrames = 2 * 48_000 + 7;
      const n = await writeClickWav(file, {
        gainDb: 0,
        sound: "beep",
        subdivision: 1,
        accent: true,
        compoundEighths: false,
        tempo: {
          map: { segments: [{ startBeat: 0, bpm: 120, meter: { num: 4, den: 4 }, barIndex: 0 }] },
          bar1OffsetSec: 0.99,
        },
        lengthFrames,
      });
      // Pulses at 0.49 (pickup), 0.99, 1.49, 1.99 s.
      expect(n).toBe(4);
      const buf = await fs.readFile(file);
      expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
      expect(buf.readUInt16LE(20)).toBe(3);
      expect(buf.readUInt32LE(24)).toBe(48_000);
      expect(buf.length).toBe(44 + lengthFrames * 4);
      const pcm = new Float32Array(
        buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length),
      );
      // The click at 0.99 s (47 520) crosses the first 48 000-frame block.
      const accent = synthClick("beep", 0);
      for (let j = 0; j < accent.length; j++)
        expect(pcm[47_520 + j]).toBeCloseTo(accent[j] ?? 0, 7);
      // The last click is cut at the song's end.
      expect(pcm[lengthFrames - 1]).not.toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
