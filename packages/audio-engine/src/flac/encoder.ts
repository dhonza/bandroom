import { BitWriter } from "./bitWriter";
import { crc16, crc8 } from "./crc";

/**
 * Streaming FLAC encoder for recorded takes (SPEC §9): 24-bit, fixed 4096-frame blocks (the last
 * one shorter), CONSTANT / FIXED (orders 0–4) / VERBATIM subframes chosen by size, partitioned
 * Rice coding (with escape partitions) and per-block stereo decorrelation (independent,
 * left/side, right/side, mid/side). MD5 stays zero.
 *
 * Usage: write {@link FlacEncoder.header} first, then the bytes of every {@link FlacEncoder.encode}
 * call and of {@link FlacEncoder.finish}; at the end, overwrite the
 * {@link FLAC_STREAMINFO_LENGTH} bytes at {@link FLAC_STREAMINFO_OFFSET} with
 * {@link FlacEncoder.streamInfo} (the header's totals are "unknown" until then).
 *
 * Buffers are reused between blocks; the only allocations are the returned byte arrays.
 */

export const FLAC_BLOCK_SIZE = 4096;
export const FLAC_BITS_PER_SAMPLE = 24;
/** Byte offset of the STREAMINFO block body in the file (after "fLaC" and its block header). */
export const FLAC_STREAMINFO_OFFSET = 8;
export const FLAC_STREAMINFO_LENGTH = 34;
/** Length of {@link FlacEncoder.header}: "fLaC" + the STREAMINFO block. */
export const FLAC_HEADER_LENGTH = FLAC_STREAMINFO_OFFSET + FLAC_STREAMINFO_LENGTH;

const MAX_PARTITION_ORDER = 8;
const MAX_FIXED_ORDER = 4;
const INT24_MAX = 8_388_607;
const INT24_MIN = -8_388_608;
const SCALE = 8_388_608;

/** Frame header sample rate codes (RFC 9639 §9.1.2); others are read from STREAMINFO (0). */
const RATE_CODES: Record<number, number> = {
  88_200: 1,
  176_400: 2,
  192_000: 3,
  8_000: 4,
  16_000: 5,
  22_050: 6,
  24_000: 7,
  32_000: 8,
  44_100: 9,
  48_000: 10,
  96_000: 11,
};

/** Channel assignments of a stereo frame. */
const INDEPENDENT = 1;
const LEFT_SIDE = 8;
const RIGHT_SIDE = 9;
const MID_SIDE = 10;

const enum Kind {
  Constant,
  Fixed,
  Verbatim,
}

/** The chosen coding of one subframe, with its residual and Rice partitions. */
class Plan {
  kind = Kind.Verbatim;
  order = 0;
  /** Estimated size in bits, header included. */
  bits = 0;
  partitionOrder = 0;
  /** Rice parameter per partition, or -1 for an escape partition (raw `escapeBits`). */
  readonly params = new Int8Array(1 << MAX_PARTITION_ORDER);
  readonly escapeBits = new Uint8Array(1 << MAX_PARTITION_ORDER);
  /** 5-bit Rice parameters (method 1) when any parameter exceeds 14. */
  rice2 = false;
  /** Zigzag-coded residual (index i ↔ sample i; the first `order` entries are unused). */
  readonly residual: Uint32Array;
  constructor(blockSize: number) {
    this.residual = new Uint32Array(blockSize);
  }
}

export interface FlacEncoderOptions {
  /** 1 or 2. */
  channels: number;
  /** Hz; default 48 000. */
  sampleRate?: number;
  /** Samples per block (16–65535); default 4096. */
  blockSize?: number;
}

export class FlacEncoder {
  readonly channels: number;
  readonly sampleRate: number;
  readonly blockSize: number;
  private readonly input: Int32Array[];
  private readonly side: Int32Array;
  private readonly mid: Int32Array;
  /** Plans for left (or mono), right, side and mid. */
  private readonly plans: Plan[];
  private readonly writer: BitWriter;
  /** Per-partition sums and maxima of the zigzag residual at the finest partition order. */
  private readonly sums = new Float64Array(1 << MAX_PARTITION_ORDER);
  private readonly maxes = new Uint32Array(1 << MAX_PARTITION_ORDER);
  private readonly tryParams = new Int8Array(1 << MAX_PARTITION_ORDER);
  private readonly tryEscape = new Uint8Array(1 << MAX_PARTITION_ORDER);
  private fill = 0;
  private frameNumber = 0;
  private total = 0;
  private minFrame = Number.POSITIVE_INFINITY;
  private maxFrame = 0;
  private finished = false;

  constructor(opts: FlacEncoderOptions) {
    if (opts.channels !== 1 && opts.channels !== 2) throw new Error("FLAC: 1 or 2 channels");
    this.channels = opts.channels;
    this.sampleRate = opts.sampleRate ?? 48_000;
    this.blockSize = opts.blockSize ?? FLAC_BLOCK_SIZE;
    if (this.blockSize < 16 || this.blockSize > 65_535) throw new Error("FLAC: block size");
    this.input = Array.from({ length: this.channels }, () => new Int32Array(this.blockSize));
    this.side = new Int32Array(this.blockSize);
    this.mid = new Int32Array(this.blockSize);
    this.plans = Array.from(
      { length: this.channels === 2 ? 4 : 1 },
      () => new Plan(this.blockSize),
    );
    // Worst case: every channel verbatim at 25 bits plus headers; grows if ever needed.
    this.writer = new BitWriter(((this.blockSize * 25 * this.channels) >> 3) * 2 + 1024);
  }

  /** Samples encoded so far (per channel), incl. those still buffered. */
  get totalSamples(): number {
    return this.total + this.fill;
  }

  /** "fLaC" and a STREAMINFO block with unknown totals and frame sizes. */
  header(): Uint8Array {
    const out = new Uint8Array(FLAC_HEADER_LENGTH);
    out.set([0x66, 0x4c, 0x61, 0x43]); // "fLaC"
    out.set([0x80, 0, 0, FLAC_STREAMINFO_LENGTH], 4); // last metadata block, STREAMINFO
    out.set(this.makeStreamInfo(0, 0, 0), FLAC_STREAMINFO_OFFSET);
    return out;
  }

  /**
   * Adds `frames` samples of each channel (planar floats, ±1 = full scale; clipped) and returns
   * the bytes of the frames completed by them (often empty). Chunks may have any length.
   */
  encode(planar: readonly Float32Array[], frames?: number): Uint8Array {
    if (this.finished) throw new Error("FLAC: encoder finished");
    if (planar.length !== this.channels) throw new Error("FLAC: channel count");
    const n = frames ?? planar[0]?.length ?? 0;
    let off = 0;
    while (off < n) {
      const take = Math.min(n - off, this.blockSize - this.fill);
      for (let c = 0; c < this.channels; c++) {
        const src = planar[c] as Float32Array;
        const dst = this.input[c] as Int32Array;
        const base = this.fill - off;
        for (let i = off; i < off + take; i++) {
          let x = (src[i] as number) * SCALE;
          x = x > INT24_MAX ? INT24_MAX : x < INT24_MIN ? INT24_MIN : x;
          dst[base + i] = Math.round(x);
        }
      }
      this.fill += take;
      off += take;
      if (this.fill === this.blockSize) this.encodeFrame(this.blockSize);
    }
    return this.writer.take();
  }

  /** Encodes the buffered rest as a last, shorter frame and returns its bytes. */
  finish(): Uint8Array {
    if (!this.finished && this.fill > 0) this.encodeFrame(this.fill);
    this.finished = true;
    return this.writer.take();
  }

  /**
   * The final STREAMINFO block body (34 bytes) to write at {@link FLAC_STREAMINFO_OFFSET}: total
   * samples, block sizes and min/max frame sizes of what was encoded; MD5 zero.
   */
  streamInfo(): Uint8Array {
    const frames = this.maxFrame > 0;
    return this.makeStreamInfo(this.total, frames ? this.minFrame : 0, frames ? this.maxFrame : 0);
  }

  private makeStreamInfo(total: number, minFrame: number, maxFrame: number): Uint8Array {
    return buildStreamInfo({
      minBlockSize: this.blockSize,
      maxBlockSize: this.blockSize,
      minFrameSize: minFrame,
      maxFrameSize: maxFrame,
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitsPerSample: FLAC_BITS_PER_SAMPLE,
      totalSamples: total,
    });
  }

  private encodeFrame(n: number): void {
    const w = this.writer;
    const start = w.pos;
    let assignment = 0;
    let first: Plan;
    let second: Plan | null = null;
    let firstSignal: Int32Array;
    let secondSignal: Int32Array | null = null;
    let firstBps = FLAC_BITS_PER_SAMPLE;
    let secondBps = FLAC_BITS_PER_SAMPLE;
    const [p0, p1, p2, p3] = this.plans as [Plan, Plan?, Plan?, Plan?];
    const l = this.input[0] as Int32Array;
    if (this.channels === 1 || !p1 || !p2 || !p3) {
      this.plan(p0, l, n, FLAC_BITS_PER_SAMPLE);
      first = p0;
      firstSignal = l;
    } else {
      const r = this.input[1] as Int32Array;
      const side = this.side;
      const mid = this.mid;
      for (let i = 0; i < n; i++) {
        const a = l[i] as number;
        const b = r[i] as number;
        side[i] = a - b;
        mid[i] = (a + b) >> 1;
      }
      const bl = this.plan(p0, l, n, 24);
      const br = this.plan(p1, r, n, 24);
      const bs = this.plan(p2, side, n, 25);
      const bm = this.plan(p3, mid, n, 24);
      const best = Math.min(bl + br, bl + bs, bs + br, bm + bs);
      if (best === bl + br) {
        assignment = INDEPENDENT;
        [first, second, firstSignal, secondSignal] = [p0, p1, l, r];
      } else if (best === bl + bs) {
        assignment = LEFT_SIDE;
        [first, second, firstSignal, secondSignal, secondBps] = [p0, p2, l, side, 25];
      } else if (best === bs + br) {
        assignment = RIGHT_SIDE;
        [first, second, firstSignal, secondSignal, firstBps] = [p2, p1, side, r, 25];
      } else {
        assignment = MID_SIDE;
        [first, second, firstSignal, secondSignal, secondBps] = [p3, p2, mid, side, 25];
      }
    }
    this.writeFrameHeader(n, assignment);
    this.writeSubframe(first, firstSignal, n, firstBps);
    if (second && secondSignal) this.writeSubframe(second, secondSignal, n, secondBps);
    w.align();
    const crc = crc16(w.buf, start, w.pos);
    w.byte(crc >>> 8);
    w.byte(crc & 0xff);
    const size = w.pos - start;
    if (size < this.minFrame) this.minFrame = size;
    if (size > this.maxFrame) this.maxFrame = size;
    this.total += n;
    this.fill = 0;
    this.frameNumber++;
  }

  private writeFrameHeader(n: number, assignment: number): void {
    const w = this.writer;
    const start = w.pos;
    const bsCode = blockSizeCode(n);
    w.byte(0xff);
    w.byte(0xf8); // sync, fixed block size strategy
    w.byte((bsCode << 4) | (RATE_CODES[this.sampleRate] ?? 0));
    w.byte((assignment << 4) | (0b110 << 1)); // 24 bits per sample
    writeUtf8Number(w, this.frameNumber);
    if (bsCode === 6) w.byte(n - 1);
    else if (bsCode === 7) w.write(n - 1, 16);
    w.byte(crc8(w.buf, start, w.pos));
  }

  /** Chooses the coding of one channel; returns its estimated size in bits. */
  private plan(p: Plan, x: Int32Array, n: number, bps: number): number {
    const verbatim = 8 + n * bps;
    const x0 = x[0] as number;
    let constant = true;
    for (let i = 1; i < n; i++) {
      if (x[i] !== x0) {
        constant = false;
        break;
      }
    }
    if (constant) {
      p.kind = Kind.Constant;
      p.bits = 8 + bps;
      return p.bits;
    }
    // Total |residual| of each fixed order over the same samples (as libFLAC does).
    const order = bestFixedOrder(x, n);
    const res = p.residual;
    fixedResidual(x, n, order, res);
    const bits = 8 + order * bps + this.partition(p, res, n, order);
    if (bits < verbatim) {
      p.kind = Kind.Fixed;
      p.order = order;
      p.bits = bits;
    } else {
      p.kind = Kind.Verbatim;
      p.bits = verbatim;
    }
    return p.bits;
  }

  /** Picks the partition order and Rice parameters; returns the residual's estimated bits. */
  private partition(p: Plan, res: Uint32Array, n: number, order: number): number {
    let maxOrder = 0;
    while (
      maxOrder < MAX_PARTITION_ORDER &&
      n % (1 << (maxOrder + 1)) === 0 &&
      n >> (maxOrder + 1) >= order
    )
      maxOrder++;
    const sums = this.sums;
    const maxes = this.maxes;
    // Finest partitions first.
    const parts = 1 << maxOrder;
    const len = n >> maxOrder;
    for (let j = 0; j < parts; j++) {
      let s = 0;
      let m = 0;
      const end = (j + 1) * len;
      for (let i = j === 0 ? order : j * len; i < end; i++) {
        const u = res[i] as number;
        s += u;
        if (u > m) m = u;
      }
      sums[j] = s;
      maxes[j] = m;
    }
    let best = Number.POSITIVE_INFINITY;
    for (let po = maxOrder; po >= 0; po--) {
      const count = 1 << po;
      if (po < maxOrder) {
        // Merge pairs in place: partition j of order po = 2j and 2j+1 of po + 1.
        for (let j = 0; j < count; j++) {
          sums[j] = (sums[2 * j] as number) + (sums[2 * j + 1] as number);
          maxes[j] = Math.max(maxes[2 * j] as number, maxes[2 * j + 1] as number);
        }
      }
      const plen = n >> po;
      let bits = 0;
      let rice2 = false;
      for (let j = 0; j < count; j++) {
        const samples = j === 0 ? plen - order : plen;
        const sum = sums[j] as number;
        const k = riceParameter(sum, samples);
        const riceBits = riceCost(sum, samples, k);
        // Escape: raw signed values of the width the largest residual needs.
        const width = bitWidth(maxes[j] as number);
        const escapeBits = 5 + samples * width;
        if (escapeBits < riceBits) {
          this.tryParams[j] = -1;
          this.tryEscape[j] = width;
          bits += escapeBits;
        } else {
          this.tryParams[j] = k;
          if (k > 14) rice2 = true;
          bits += riceBits;
        }
      }
      bits += 2 + 4 + count * (rice2 ? 5 : 4);
      if (bits < best) {
        best = bits;
        p.partitionOrder = po;
        p.rice2 = rice2;
        p.params.set(this.tryParams.subarray(0, count));
        p.escapeBits.set(this.tryEscape.subarray(0, count));
      }
    }
    return best;
  }

  private writeSubframe(p: Plan, x: Int32Array, n: number, bps: number): void {
    const w = this.writer;
    // Signed values are written as two's complement: BitWriter.write keeps the low bits.
    if (p.kind === Kind.Constant) {
      w.byte(0);
      w.write(x[0] as number, bps);
      return;
    }
    if (p.kind === Kind.Fixed) {
      const mark = w.mark();
      const before = w.bitLength();
      w.byte((0b001000 | p.order) << 1);
      for (let i = 0; i < p.order; i++) w.write(x[i] as number, bps);
      this.writeResidual(p, n);
      // The estimate was optimistic: fall back to verbatim, which bounds every frame.
      if (w.bitLength() - before <= 8 + n * bps) return;
      w.rewind(mark);
    }
    w.byte(0b000001 << 1);
    for (let i = 0; i < n; i++) w.write(x[i] as number, bps);
  }

  private writeResidual(p: Plan, n: number): void {
    const w = this.writer;
    const res = p.residual;
    const po = p.partitionOrder;
    const paramBits = p.rice2 ? 5 : 4;
    const escapeCode = p.rice2 ? 31 : 15;
    w.write(p.rice2 ? 1 : 0, 2);
    w.write(po, 4);
    const plen = n >> po;
    const count = 1 << po;
    for (let j = 0; j < count; j++) {
      const start = j === 0 ? p.order : j * plen;
      const end = (j + 1) * plen;
      const k = p.params[j] as number;
      if (k < 0) {
        const width = p.escapeBits[j] as number;
        w.write(escapeCode, paramBits);
        w.write(width, 5);
        if (width > 0) {
          for (let i = start; i < end; i++) {
            const u = res[i] as number;
            w.write(u & 1 ? -((u + 1) / 2) : u / 2, width);
          }
        }
        continue;
      }
      w.write(k, paramBits);
      const lowMask = k === 0 ? 0 : k >= 31 ? 0x7fffffff : (1 << k) - 1;
      const div = 2 ** k;
      for (let i = start; i < end; i++) {
        const u = res[i] as number;
        w.rice(Math.floor(u / div), u & lowMask, k);
      }
    }
  }
}

/** The fields of a STREAMINFO block body (34 bytes, RFC 9639 §8.2). */
export interface StreamInfo {
  minBlockSize: number;
  maxBlockSize: number;
  minFrameSize: number;
  maxFrameSize: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
}

export function buildStreamInfo(s: StreamInfo): Uint8Array {
  const b = new Uint8Array(FLAC_STREAMINFO_LENGTH);
  b[0] = s.minBlockSize >>> 8;
  b[1] = s.minBlockSize & 0xff;
  b[2] = s.maxBlockSize >>> 8;
  b[3] = s.maxBlockSize & 0xff;
  b[4] = (s.minFrameSize >>> 16) & 0xff;
  b[5] = (s.minFrameSize >>> 8) & 0xff;
  b[6] = s.minFrameSize & 0xff;
  b[7] = (s.maxFrameSize >>> 16) & 0xff;
  b[8] = (s.maxFrameSize >>> 8) & 0xff;
  b[9] = s.maxFrameSize & 0xff;
  b[10] = (s.sampleRate >>> 12) & 0xff;
  b[11] = (s.sampleRate >>> 4) & 0xff;
  b[12] = ((s.sampleRate & 0xf) << 4) | ((s.channels - 1) << 1) | ((s.bitsPerSample - 1) >> 4);
  const high = Math.floor(s.totalSamples / 2 ** 32) & 0xf;
  b[13] = (((s.bitsPerSample - 1) & 0xf) << 4) | high;
  const low = s.totalSamples % 2 ** 32;
  b[14] = (low >>> 24) & 0xff;
  b[15] = (low >>> 16) & 0xff;
  b[16] = (low >>> 8) & 0xff;
  b[17] = low & 0xff;
  return b; // MD5 (bytes 18–33) stays zero: unknown
}

export function parseStreamInfo(b: Uint8Array): StreamInfo {
  const u = (i: number) => b[i] ?? 0;
  return {
    minBlockSize: (u(0) << 8) | u(1),
    maxBlockSize: (u(2) << 8) | u(3),
    minFrameSize: (u(4) << 16) | (u(5) << 8) | u(6),
    maxFrameSize: (u(7) << 16) | (u(8) << 8) | u(9),
    sampleRate: (u(10) << 12) | (u(11) << 4) | (u(12) >> 4),
    channels: ((u(12) >> 1) & 7) + 1,
    bitsPerSample: (((u(12) & 1) << 4) | (u(13) >> 4)) + 1,
    totalSamples:
      (u(13) & 0xf) * 2 ** 32 + ((u(14) << 24) >>> 0) + (u(15) << 16) + (u(16) << 8) + u(17),
  };
}

function blockSizeCode(n: number): number {
  for (let j = 0; j < 8; j++) if (n === 256 << j) return 8 + j;
  return n <= 256 ? 6 : 7;
}

/** FLAC's UTF-8-like coding of the frame number (up to 31 bits here). */
function writeUtf8Number(w: BitWriter, v: number): void {
  if (v < 0x80) {
    w.byte(v);
    return;
  }
  let bytes = 2;
  while (bytes < 6 && v >= 2 ** (5 * bytes + 1)) bytes++;
  const lead = (0xff00 >> bytes) & 0xff;
  w.byte(lead | (v >>> (6 * (bytes - 1))));
  for (let i = bytes - 2; i >= 0; i--) w.byte(0x80 | ((v >>> (6 * i)) & 0x3f));
}

/** The fixed predictor order (0–4) with the smallest total |residual|. */
function bestFixedOrder(x: Int32Array, n: number): number {
  if (n <= MAX_FIXED_ORDER) return 0;
  let e0 = 0;
  let e1 = 0;
  let e2 = 0;
  let e3 = 0;
  let e4 = 0;
  let a = x[3] as number;
  let d1 = a - (x[2] as number);
  let d2 = d1 - ((x[2] as number) - (x[1] as number));
  let d3 = d2 - ((x[2] as number) - 2 * (x[1] as number) + (x[0] as number));
  for (let i = MAX_FIXED_ORDER; i < n; i++) {
    const v = x[i] as number;
    const n1 = v - a;
    const n2 = n1 - d1;
    const n3 = n2 - d2;
    const n4 = n3 - d3;
    e0 += v < 0 ? -v : v;
    e1 += n1 < 0 ? -n1 : n1;
    e2 += n2 < 0 ? -n2 : n2;
    e3 += n3 < 0 ? -n3 : n3;
    e4 += n4 < 0 ? -n4 : n4;
    a = v;
    d1 = n1;
    d2 = n2;
    d3 = n3;
  }
  let order = 0;
  let best = e0;
  if (e1 < best) [order, best] = [1, e1];
  if (e2 < best) [order, best] = [2, e2];
  if (e3 < best) [order, best] = [3, e3];
  if (e4 < best) order = 4;
  return order;
}

/** Zigzag-coded residual of the fixed predictor `order` for samples order…n−1. */
function fixedResidual(x: Int32Array, n: number, order: number, out: Uint32Array): void {
  for (let i = order; i < n; i++) {
    const v = x[i] as number;
    let r: number;
    switch (order) {
      case 0:
        r = v;
        break;
      case 1:
        r = v - (x[i - 1] as number);
        break;
      case 2:
        r = v - 2 * (x[i - 1] as number) + (x[i - 2] as number);
        break;
      case 3:
        r = v - 3 * (x[i - 1] as number) + 3 * (x[i - 2] as number) - (x[i - 3] as number);
        break;
      default:
        r =
          v -
          4 * (x[i - 1] as number) +
          6 * (x[i - 2] as number) -
          4 * (x[i - 3] as number) +
          (x[i - 4] as number);
    }
    out[i] = r >= 0 ? 2 * r : -2 * r - 1;
  }
}

/** The Rice parameter near log2 of the mean, refined by the size estimate. */
function riceParameter(sum: number, samples: number): number {
  if (samples === 0 || sum === 0) return 0;
  let k = Math.max(0, Math.floor(Math.log2(sum / samples)));
  if (k > 30) k = 30;
  let best = k;
  let bestBits = riceCost(sum, samples, k);
  for (const c of [k - 1, k + 1]) {
    if (c < 0 || c > 30) continue;
    const bits = riceCost(sum, samples, c);
    if (bits < bestBits) [best, bestBits] = [c, bits];
  }
  return best;
}

/** Estimated bits of Rice-coding `samples` values summing to `sum` with parameter `k`. */
function riceCost(sum: number, samples: number, k: number): number {
  return samples * (k + 1) + Math.floor(sum / 2 ** k);
}

/** Bits a two's complement value needs when its zigzag code is at most `maxZigzag`. */
function bitWidth(maxZigzag: number): number {
  return maxZigzag === 0 ? 0 : Math.floor(Math.log2(maxZigzag)) + 1;
}
