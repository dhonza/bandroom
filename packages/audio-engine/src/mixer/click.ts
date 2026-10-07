/**
 * Click sounds (SPEC §6.7) live in `@bandroom/shared/audio`, so the server's bounce renders the
 * same samples (SPEC §5.5); the voices that play them in the worklet are here.
 */
export {
  CLICK_SOUNDS,
  clickSampleLevel,
  clickSamples,
  synthClick,
  type ClickLevel,
  type ClickSampleSet,
  type ClickSound,
} from "@bandroom/shared/audio";

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
