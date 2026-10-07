import { describe, expect, it } from "vitest";
import { FlacFrameSplitter, flacHeaderLength } from "./flacFrames";
import { isOpusHeaderPacket, OggDemuxer, opusPacketSamples } from "./ogg";
import { Resampler, resamplerPlan } from "./resample";
import { entryAtOrBefore, flacSeekPoint, opusSeekPoint } from "./seek";
import { OpusStream, type OpusCodec } from "./streams";

/** One Ogg page carrying `packets`; a packet longer than the page's share continues. */
function page(
  flags: number,
  granule: number,
  laces: number[],
  body: Uint8Array,
  seq = 0,
): Uint8Array {
  const out = new Uint8Array(27 + laces.length + body.length);
  out.set([0x4f, 0x67, 0x67, 0x53, 0, flags]);
  const v = new DataView(out.buffer);
  if (granule < 0) {
    v.setUint32(6, 0xffffffff, true);
    v.setUint32(10, 0xffffffff, true);
  } else {
    v.setUint32(6, granule % 2 ** 32, true);
    v.setUint32(10, Math.floor(granule / 2 ** 32), true);
  }
  v.setUint32(18, seq, true);
  out[26] = laces.length;
  out.set(laces, 27);
  out.set(body, 27 + laces.length);
  return out;
}

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe("OggDemuxer", () => {
  it("assembles packets across pages and chunk boundaries", () => {
    // Page 1: packet A (10 bytes), then the first 255 bytes of packet B.
    const p1 = page(0, 100, [10, 255], new Uint8Array([...bytes(10, 1), ...bytes(255, 2)]));
    // Page 2 continues B with 5 more bytes, then packet C (3 bytes).
    const p2 = page(1, 200, [5, 3], new Uint8Array([...bytes(5, 2), ...bytes(3, 3)]));
    const all = new Uint8Array([...p1, ...p2]);
    const d = new OggDemuxer();
    const pages = [...d.push(all.subarray(0, 40)), ...d.push(all.subarray(40))];
    expect(pages.map((p) => p.granule)).toEqual([100, 200]);
    expect(pages[0]?.packets.map((p) => p.length)).toEqual([10]);
    expect(pages[1]?.packets.map((p) => p.length)).toEqual([260, 3]);
    expect(pages[1]?.droppedContinuation).toBe(false);
  });

  it("drops a continued packet whose start was never seen (after a seek)", () => {
    const p2 = page(1, 200, [5, 3], new Uint8Array([...bytes(5, 2), ...bytes(3, 3)]));
    const [pg] = new OggDemuxer().push(p2);
    expect(pg?.droppedContinuation).toBe(true);
    expect(pg?.packets.map((p) => p.length)).toEqual([3]);
  });

  it("reports -1 granules and rejects garbage", () => {
    const [pg] = new OggDemuxer().push(page(0, -1, [255], bytes(255, 9)));
    expect(pg?.granule).toBe(-1);
    expect(pg?.packets).toEqual([]);
    expect(() => new OggDemuxer().push(bytes(40, 7))).toThrow(/capture/);
  });

  it("reads 64-bit granules", () => {
    const [pg] = new OggDemuxer().push(page(0, 2 ** 33 + 5, [1], bytes(1, 0)));
    expect(pg?.granule).toBe(2 ** 33 + 5);
  });
});

describe("Opus packets", () => {
  it("derives sample counts from the TOC byte", () => {
    // CELT 20 ms (config 31), one frame.
    expect(opusPacketSamples(new Uint8Array([(31 << 3) | 0]))).toBe(960);
    // CELT 2.5 ms, two frames.
    expect(opusPacketSamples(new Uint8Array([(16 << 3) | 1]))).toBe(240);
    // SILK 60 ms, one frame; hybrid 10 ms, code 3 with 3 frames.
    expect(opusPacketSamples(new Uint8Array([(3 << 3) | 0]))).toBe(2880);
    expect(opusPacketSamples(new Uint8Array([(12 << 3) | 3, 3]))).toBe(1440);
    expect(opusPacketSamples(new Uint8Array([]))).toBe(0);
  });

  it("recognizes header packets", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(isOpusHeaderPacket(enc("OpusHead\x01\x02"))).toBe(true);
    expect(isOpusHeaderPacket(enc("OpusTags...."))).toBe(true);
    expect(isOpusHeaderPacket(enc("OpusXxxx"))).toBe(false);
    expect(isOpusHeaderPacket(new Uint8Array([0xf8]))).toBe(false);
  });
});

/** A fake codec that outputs each packet's first byte as a constant level. */
const fakeCodec = (): OpusCodec => ({
  decodeFrames: (frames) => {
    const n = frames.reduce((a, f) => a + opusPacketSamples(f), 0);
    const out = new Float32Array(n);
    let o = 0;
    for (const f of frames) {
      out.fill((f[1] ?? 0) / 100, o, o + opusPacketSamples(f));
      o += opusPacketSamples(f);
    }
    return { channelData: [out], samplesDecoded: n };
  },
  free: () => undefined,
});

describe("OpusStream positioning", () => {
  const pkt = (level: number) => new Uint8Array([31 << 3, level]); // 960 samples
  it("positions from the granule when the page starts with a dropped continuation", async () => {
    // Page: tail of an unseen packet, then two 960-sample packets ending at granule 5000.
    const body = new Uint8Array([...bytes(4, 0), ...pkt(10), ...pkt(20)]);
    const s = new OpusStream(
      fakeCodec(),
      { channels: 1, preSkip: 312, totalSamples: 10_000 },
      null,
      0,
    );
    const blocks = await s.push(page(1, 5000, [4, 2, 2], body));
    // First full packet starts at decoder sample 5000 − 1920 = 3080 → timeline 2768.
    expect(blocks[0]?.frame).toBe(2768);
    expect(blocks[0]?.data[0]?.length).toBe(1920);
  });

  it("applies pre-skip at the start and trims pre-roll and the end", async () => {
    const s = new OpusStream(
      fakeCodec(),
      { channels: 2, preSkip: 312, totalSamples: 1500 },
      0,
      100,
    );
    const blocks = await s.push(
      new Uint8Array([
        ...page(2, 0, [8], new TextEncoder().encode("OpusHead")),
        ...page(4, 1920, [2, 2], new Uint8Array([...pkt(10), ...pkt(20)])),
      ]),
    );
    // Timeline starts at −312; keep [100, 1500).
    expect(blocks[0]?.frame).toBe(100);
    expect(blocks[0]?.data.length).toBe(2); // mono output copied to both channels
    expect(blocks[0]?.data[0]?.length).toBe(1400);
    expect(blocks[0]?.data[0]?.[0]).toBeCloseTo(0.1);
    expect(blocks[0]?.data[0]?.[1399]).toBeCloseTo(0.2);
    expect(await s.push(page(0, 3000, [2], pkt(1)))).toEqual([]); // done
    expect(await s.flush()).toEqual([]);
  });

  it("refuses to position on a last page that starts mid-packet", async () => {
    const s = new OpusStream(fakeCodec(), { channels: 1, preSkip: 0, totalSamples: 10 }, null, 0);
    await expect(
      s.push(page(5, 900, [3, 2], new Uint8Array([0, 0, 0, ...pkt(1)]))),
    ).rejects.toThrow(/last page/);
  });
});

describe("seek points", () => {
  const index = [
    [0, 100],
    [48_000, 5000],
    [96_000, 9000],
  ] as const;
  it("finds entries by binary search", () => {
    expect(entryAtOrBefore(index, -5)).toBe(0);
    expect(entryAtOrBefore(index, 48_000)).toBe(1);
    expect(entryAtOrBefore(index, 1e9)).toBe(2);
    expect(entryAtOrBefore([], 10)).toBe(0);
  });
  it("gives Opus at least 80 ms of pre-roll and decoder index 0 for the first page", () => {
    expect(opusSeekPoint(index, 312, 48_000 + 3840 + 5760)).toEqual({
      byteOffset: 5000,
      startDecoded: 48_312,
    });
    expect(opusSeekPoint(index, 312, 48_000 + 1000)).toEqual({ byteOffset: 100, startDecoded: 0 });
    expect(opusSeekPoint([], 312, 5)).toEqual({ byteOffset: 0, startDecoded: 0 });
  });
  it("gives FLAC the frame at or before the target", () => {
    expect(flacSeekPoint(index, 95_999)).toEqual({ byteOffset: 5000, frame: 48_000 });
    expect(flacSeekPoint([], 5)).toEqual({ byteOffset: 0, frame: 0 });
  });
});

describe("Resampler", () => {
  function sine(rate: number, hz: number, n: number, phase0 = 0) {
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = 0.5 * Math.sin(2 * Math.PI * hz * ((i + phase0) / rate));
    return s;
  }

  for (const rate of [44_100, 88_200, 96_000, 32_000]) {
    it(`converts ${rate} Hz to 48 kHz with > 80 dB SNR for a 1 kHz sine`, () => {
      const src = sine(rate, 1000, rate);
      const r = new Resampler(rate, 1, 0, 0);
      const parts = [r.push([src.subarray(0, 12_345)]), r.push([src.subarray(12_345)]), r.flush()];
      const out = new Float32Array(parts.reduce((a, p) => a + (p[0]?.length ?? 0), 0));
      let o = 0;
      for (const p of parts) {
        out.set(p[0] ?? [], o);
        o += p[0]?.length ?? 0;
      }
      expect(Math.abs(out.length - 48_000)).toBeLessThanOrEqual(resamplerPlan(rate).halfWidth + 2);
      const want = sine(48_000, 1000, 48_000);
      let sig = 0;
      let err = 0;
      for (let i = 2000; i < 46_000; i++) {
        sig += (want[i] ?? 0) ** 2;
        err += ((out[i] ?? 0) - (want[i] ?? 0)) ** 2;
      }
      expect(10 * Math.log10(sig / err)).toBeGreaterThan(80);
    });
  }

  it("produces identical samples when started mid-stream", () => {
    const rate = 44_100;
    const src = sine(rate, 440, rate);
    const full = new Resampler(rate, 1, 0, 0).push([src])[0] ?? new Float32Array(0);
    const startOut = 20_000;
    const startIn = Math.floor((startOut * 147) / 160) - resamplerPlan(rate).halfWidth + 1 - 7;
    const part = new Resampler(rate, 1, startIn, startOut).push([src.subarray(startIn)])[0];
    for (let i = 0; i < 1000; i++) expect(part?.[i]).toBeCloseTo(full[startOut + i] ?? 0, 6);
  });
});

describe("FlacFrameSplitter", () => {
  it("validates header CRC-8", () => {
    // Fixed blocking, 4096 samples (code 12), 44.1 kHz (code 9), mono, 16 bit, frame 0.
    const h = new Uint8Array([0xff, 0xf8, 0xc9, 0x08, 0x00, 0x00, 0, 0]);
    let crc = 0;
    for (const b of h.subarray(0, 5)) {
      crc ^= b;
      for (let k = 0; k < 8; k++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
    h[5] = crc;
    expect(flacHeaderLength(h, 0)).toBe(6);
    h[5] = crc ^ 1;
    expect(flacHeaderLength(h, 0)).toBe(0);
    expect(flacHeaderLength(new Uint8Array([0xff, 0xf8, 0x09, 0x08, 0, 0, 0]), 0)).toBe(0); // bs 0
  });

  it("returns nothing for data without a sync code", () => {
    const s = new FlacFrameSplitter();
    expect(s.push(bytes(100, 0))).toEqual([]);
    expect(s.flush()).toEqual([]);
  });
});
