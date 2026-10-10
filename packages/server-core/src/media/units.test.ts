import { describe, expect, it } from "vitest";
import { parseEbur128Summary } from "./analysis";
import { durationSamples48k, isLosslessFlacCandidate } from "./ingest";
import { decodeDat, encodeDat, overviewFromPairs, PeaksAccumulator } from "./peaks";
import type { Probe } from "./probe";

describe("PeaksAccumulator", () => {
  it("computes 16-bit min/max per block across channels, across chunk boundaries", () => {
    const acc = new PeaksAccumulator(2, 2);
    const frames = [
      [1000, -2000],
      [30000, 0],
      [-32768, 256],
      [0, 0],
      [512, -512],
    ];
    const buf = Buffer.alloc(frames.length * 4);
    frames.forEach(([l, r], i) => {
      buf.writeInt16LE(l ?? 0, i * 4);
      buf.writeInt16LE(r ?? 0, i * 4 + 2);
    });
    acc.push(buf.subarray(0, 7)); // split mid-sample
    acc.push(buf.subarray(7));
    expect(Array.from(acc.finish())).toEqual([-2000, 30000, -32768, 256, -512, 512]);
  });

  it("keeps every pair past its initial capacity", () => {
    const acc = new PeaksAccumulator(1, 1);
    const n = 10_000; // pairs; more than the initial storage holds
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) buf.writeInt16LE(i - 5_000, i * 2);
    acc.push(buf);
    const pairs = acc.finish();
    expect(pairs).toBeInstanceOf(Int16Array);
    expect(pairs.length).toBe(2 * n);
    expect(pairs[2 * 9_999]).toBe(4_999);
    expect(pairs[2 * 9_999 + 1]).toBe(4_999);
  });

  it("round-trips the 16-bit .dat format and builds an overview", () => {
    const pairs = Int16Array.from([-2560, 2600, -32768, 32767, 0, 1300]);
    const back = decodeDat(encodeDat(pairs, 44_100, 256));
    expect(back).toMatchObject({ sampleRate: 44_100, spp: 256, bits: 16 });
    expect(Array.from(back.pairs)).toEqual(Array.from(pairs));
    expect(overviewFromPairs(pairs, 3)).toEqual([10, 127, 5]);
    expect(overviewFromPairs(new Int16Array(0), 2)).toEqual([0, 0]);
  });

  it("reads older 8-bit .dat files on the 16-bit scale", () => {
    const buf = Buffer.alloc(24);
    buf.writeInt32LE(1, 0);
    buf.writeUInt32LE(1, 4); // 8-bit
    buf.writeInt32LE(48_000, 8);
    buf.writeInt32LE(256, 12);
    buf.writeUInt32LE(2, 16);
    Buffer.from(Int8Array.from([-10, 10, -128, 127]).buffer).copy(buf, 20);
    const back = decodeDat(buf);
    expect(back.bits).toBe(8);
    expect(Array.from(back.pairs)).toEqual([-2560, 2560, -32768, 32512]);
  });
});

describe("ingest helpers", () => {
  it("computes the exact 48 kHz length", () => {
    expect(durationSamples48k(44_100, 44_100)).toBe(48_000);
    expect(durationSamples48k(96_000 * 6, 96_000)).toBe(288_000);
    expect(durationSamples48k(1, 44_100)).toBe(1);
  });

  it("decides which sources get a verified lossless FLAC", () => {
    const p = (x: Partial<Probe>) =>
      ({ lossless: true, isFloat: false, bitDepth: 24, ...x }) as Probe;
    expect(isLosslessFlacCandidate(p({}))).toBe(true);
    expect(isLosslessFlacCandidate(p({ isFloat: true, bitDepth: 32 }))).toBe(false);
    expect(isLosslessFlacCandidate(p({ bitDepth: 32 }))).toBe(false);
    expect(isLosslessFlacCandidate(p({ lossless: false }))).toBe(false);
  });

  it("parses the ebur128 summary", () => {
    const lines = [
      "[Parsed_ebur128_0 @ 0x1] t: 1 M: -20 S: -20 I: -30 LUFS",
      "[Parsed_ebur128_0 @ 0x1] Summary:",
      "  Integrated loudness:",
      "    I:         -14.2 LUFS",
      "    Threshold: -24.5 LUFS",
      "  Loudness range:",
      "    LRA:         5.3 LU",
      "  True peak:",
      "    Peak:       -0.4 dBFS",
    ];
    expect(parseEbur128Summary(lines)).toEqual({
      integratedLufs: -14.2,
      lra: 5.3,
      truePeakDbtp: -0.4,
    });
    expect(parseEbur128Summary(["no summary"])).toEqual({
      integratedLufs: null,
      lra: null,
      truePeakDbtp: null,
    });
  });
});
