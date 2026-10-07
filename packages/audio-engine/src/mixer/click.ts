import { SAMPLE_RATE } from "../constants";

/**
 * Click sounds (SPEC §6.7): short samples synthesized once in the engine (no files), with an
 * accented downbeat (higher pitch, louder) and a softer subdivision. Deterministic, so tests can
 * find every click onset.
 */

export const CLICK_SOUNDS = ["woodblock", "beep", "hihat"] as const;
export type ClickSound = (typeof CLICK_SOUNDS)[number];

/** 0 = accented downbeat, 1 = beat, 2 = subdivision. */
export type ClickLevel = 0 | 1 | 2;

const LEVEL_GAIN = [1, 0.7, 0.4] as const;

/** Deterministic noise (xorshift32) for the hi-hat. */
function noise(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x80000000 - 1;
  };
}

/** One click sample: 20–40 ms, starting at its first sample (the onset). */
export function synthClick(sound: ClickSound, level: ClickLevel): Float32Array {
  const accent = level === 0;
  const gain = LEVEL_GAIN[level];
  const ms = sound === "beep" ? 40 : sound === "hihat" ? 25 : 30;
  const n = Math.round((ms / 1000) * SAMPLE_RATE);
  const out = new Float32Array(n);
  const attack = 48; // 1 ms
  const release = 240; // 5 ms fade at the end: no click from the click
  if (sound === "hihat") {
    const rnd = noise(accent ? 7 : 3);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const w = rnd();
      const hp = w - prev; // crude high-pass: brighter noise
      prev = w;
      const env = Math.exp(-i / (SAMPLE_RATE * (accent ? 0.012 : 0.008)));
      out[i] = 0.5 * hp * env;
    }
  } else {
    const f = sound === "beep" ? (accent ? 1760 : 880) : accent ? 1600 : 1100;
    const tau = sound === "beep" ? 0.02 : 0.006;
    for (let i = 0; i < n; i++) {
      const env = Math.exp(-i / (SAMPLE_RATE * tau));
      let s = Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE) * env;
      if (sound === "woodblock")
        s += 0.3 * Math.sin((2 * Math.PI * f * 2.7 * i) / SAMPLE_RATE) * env;
      out[i] = 0.8 * s;
    }
  }
  for (let i = 0; i < n; i++) {
    const a = i < attack ? i / attack : 1;
    const r = i > n - release ? (n - i) / release : 1;
    out[i] = (out[i] ?? 0) * a * r * gain;
  }
  return out;
}

export type ClickSampleSet = [Float32Array, Float32Array, Float32Array];

export function clickSamples(sound: ClickSound): ClickSampleSet {
  return [synthClick(sound, 0), synthClick(sound, 1), synthClick(sound, 2)];
}

/** The click track sent to the mixer: pulse frames (timeline, sorted) and their levels. */
export interface ClickTrack {
  frames: Float64Array;
  levels: Uint8Array;
}

/** A count-in (SPEC §6.7): `clicks` clicks `intervalFrames` apart, accent every `perBar`. */
export interface CountInSpec {
  clicks: number;
  perBar: number;
  intervalFrames: number;
}

/** First index with `frames[i] >= f` (binary search, allocation-free). */
export function firstAtOrAfter(frames: Float64Array, f: number): number {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((frames[mid] ?? 0) < f) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const VOICES = 8;

/**
 * Fixed pool of click voices, rendered after the tracks. Voices keep ringing across seeks and
 * loop wraps, like a real metronome. Allocation-free after construction.
 */
export class ClickVoices {
  private buf: (Float32Array | null)[] = new Array<Float32Array | null>(VOICES).fill(null);
  private pos = new Int32Array(VOICES);
  /** Offset in the current block where the voice starts (0 for voices already running). */
  private start = new Int32Array(VOICES);
  private gain = new Float32Array(VOICES);
  /** Clicks triggered since load (debug state). */
  count = 0;

  trigger(sample: Float32Array, offset: number, gain: number): void {
    let v = -1;
    let oldest = -1;
    for (let i = 0; i < VOICES; i++) {
      if (this.buf[i] === null) {
        v = i;
        break;
      }
      if (oldest < 0 || (this.pos[i] ?? 0) > (this.pos[oldest] ?? 0)) oldest = i;
    }
    if (v < 0) v = oldest;
    this.buf[v] = sample;
    this.pos[v] = 0;
    this.start[v] = offset;
    this.gain[v] = gain;
    this.count++;
  }

  /** Mixes all voices into `n` frames; returns the peak added. */
  render(out0: Float32Array, out1: Float32Array, n: number): number {
    let peak = 0;
    for (let v = 0; v < VOICES; v++) {
      const b = this.buf[v];
      if (!b) continue;
      const g = this.gain[v] ?? 0;
      let p = this.pos[v] ?? 0;
      const from = this.start[v] ?? 0;
      for (let i = from; i < n && p < b.length; i++, p++) {
        const s = (b[p] ?? 0) * g;
        out0[i] = (out0[i] ?? 0) + s;
        out1[i] = (out1[i] ?? 0) + s;
        const m = s > 0 ? s : -s;
        if (m > peak) peak = m;
      }
      this.pos[v] = p;
      this.start[v] = 0;
      if (p >= b.length) this.buf[v] = null;
    }
    return peak;
  }

  reset(): void {
    this.buf.fill(null);
  }
}
