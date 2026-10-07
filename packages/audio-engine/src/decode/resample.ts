import { SAMPLE_RATE } from "../constants";

/**
 * Streaming Kaiser-windowed sinc resampler to 48 kHz for FLAC at other rates (decision log,
 * "Lossless playback"). Polyphase with exact rational positions: output frame `m` sits at source
 * position `m · srcRate / 48000`, so a seek produces the same samples as playing from the start.
 */

const BETA = 9; // ≈ 90 dB stopband
const CUTOFF = 0.455; // of the lower of the two rates (≈ 20 kHz for 44.1 kHz sources)
const BASE_HALF_WIDTH = 32; // source taps on each side at ≤ 48 kHz; scaled up when downsampling

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

export interface ResamplerPlan {
  /** Source frames advance by `up / down` per output frame. */
  up: number;
  down: number;
  halfWidth: number;
  /** `down` phases × `2 · halfWidth` taps, each phase normalized to unity DC gain. */
  taps: Float32Array;
}

const plans = new Map<number, ResamplerPlan>();

export function resamplerPlan(srcRate: number): ResamplerPlan {
  const cached = plans.get(srcRate);
  if (cached) return cached;
  const g = gcd(srcRate, SAMPLE_RATE);
  const up = srcRate / g;
  const down = SAMPLE_RATE / g;
  const halfWidth = Math.ceil(BASE_HALF_WIDTH * Math.max(1, srcRate / SAMPLE_RATE));
  const fc = (CUTOFF * Math.min(srcRate, SAMPLE_RATE)) / srcRate; // cycles per source sample
  const n = 2 * halfWidth;
  const taps = new Float32Array(down * n);
  const i0b = besselI0(BETA);
  for (let phase = 0; phase < down; phase++) {
    const frac = phase / down;
    let sum = 0;
    const row = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const u = j - halfWidth + 1 - frac; // source index − exact position
      const r = u / halfWidth;
      const w = Math.abs(r) >= 1 ? 0 : besselI0(BETA * Math.sqrt(1 - r * r)) / i0b;
      const x = 2 * fc * u;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      row[j] = 2 * fc * sinc * w;
      sum += row[j] ?? 0;
    }
    for (let j = 0; j < n; j++) taps[phase * n + j] = (row[j] ?? 0) / sum;
  }
  const plan = { up, down, halfWidth, taps };
  plans.set(srcRate, plan);
  return plan;
}

export class Resampler {
  private readonly plan: ResamplerPlan;
  /** Buffered source samples per channel; `buf[c][i]` is source frame `base + i`. */
  private buf: Float32Array[];
  private base: number;
  private len = 0;
  /** Next output frame (48 kHz timeline). */
  private out: number;

  /**
   * @param firstInFrame source frame of the first sample pushed (earlier frames count as silence)
   * @param firstOutFrame first 48 kHz frame to produce
   */
  constructor(
    srcRate: number,
    private readonly channels: number,
    firstInFrame: number,
    firstOutFrame: number,
  ) {
    this.plan = resamplerPlan(srcRate);
    this.base = firstInFrame - this.plan.halfWidth; // leading zeros stand in for the past
    this.len = this.plan.halfWidth;
    this.buf = Array.from({ length: channels }, () => new Float32Array(1 << 16));
    this.out = firstOutFrame;
  }

  /** Appends source samples and returns every output frame they make computable. */
  push(input: Float32Array[]): Float32Array[] {
    const n = input[0]?.length ?? 0;
    this.ensure(this.len + n);
    for (let c = 0; c < this.channels; c++) {
      this.buf[c]?.set(input[c] ?? input[0] ?? new Float32Array(n), this.len);
    }
    this.len += n;
    return this.produce();
  }

  /** Pads with silence so the tail of the source is fully output. */
  flush(): Float32Array[] {
    return this.push(
      Array.from({ length: this.channels }, () => new Float32Array(this.plan.halfWidth + 1)),
    );
  }

  private ensure(size: number) {
    if ((this.buf[0]?.length ?? 0) >= size) return;
    let cap = this.buf[0]?.length ?? 1;
    while (cap < size) cap *= 2;
    this.buf = this.buf.map((b) => {
      const nb = new Float32Array(cap);
      nb.set(b.subarray(0, this.len));
      return nb;
    });
  }

  private produce(): Float32Array[] {
    const { up, down, halfWidth, taps } = this.plan;
    const n = 2 * halfWidth;
    const end = this.base + this.len; // exclusive source frame
    // Output m needs source frames up to floor(m·up/down) + halfWidth.
    let count = 0;
    while (Math.floor(((this.out + count) * up) / down) + halfWidth < end) count++;
    const outs = Array.from({ length: this.channels }, () => new Float32Array(count));
    for (let k = 0; k < count; k++) {
      const num = (this.out + k) * up;
      const ip = Math.floor(num / down);
      const phase = num - ip * down;
      const first = ip - halfWidth + 1 - this.base;
      const t0 = phase * n;
      for (let c = 0; c < this.channels; c++) {
        const src = this.buf[c] as Float32Array;
        let acc = 0;
        for (let j = 0; j < n; j++) acc += (src[first + j] ?? 0) * (taps[t0 + j] ?? 0);
        (outs[c] as Float32Array)[k] = acc;
      }
    }
    this.out += count;
    // Drop source samples no later output needs.
    const keepFrom = Math.floor((this.out * up) / down) - halfWidth + 1 - this.base;
    if (keepFrom > 4096) {
      for (let c = 0; c < this.channels; c++) {
        const b = this.buf[c] as Float32Array;
        b.copyWithin(0, keepFrom, this.len);
      }
      this.base += keepFrom;
      this.len -= keepFrom;
    }
    return outs;
  }
}
