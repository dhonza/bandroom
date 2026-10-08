import type { Stretcher } from "./module";

/**
 * Streams input through a stretcher at a fixed rate with exact alignment.
 *
 * `begin(pre)` starts the stream at song position `s`; the caller then pushes input continuously
 * from `s − pre` on (`pre` ≤ `preroll`, fewer at the start of a song). The first output frame
 * belongs to `s`, and output frame `k` to `s + k·rate`. The stretcher's own latency is hidden:
 * the stream holds back the first `pre + inputLatency` input frames as pre-roll, then discards
 * `outputLatency` frames of output. So output lags the input fed by `inputLatency` input frames
 * plus `outputLatency` output frames; at the end of a song, feed silence to drain it.
 *
 * The number of output frames always equals `floor(inputAfterStart / rate)`, so the time
 * mapping never drifts (Signalsmith expects integer block lengths to average out).
 */
export class StretchStream {
  /** Input frames before the start position that give the stretcher full context. */
  readonly preroll: number;
  private pre = 0;
  private held = 0;
  private readonly hold: Float32Array[];
  private started = false;
  private inTotal = 0;
  private outTotal = 0;
  private discard = 0;

  constructor(
    private readonly s: Stretcher,
    readonly rate: number,
  ) {
    if (!(rate > 0)) throw new RangeError(`stretch: rate ${rate}`);
    this.preroll = s.seekLength;
    const holdFrames = this.preroll + s.inputLatency;
    if (holdFrames > s.maxIn) throw new RangeError("stretch: maxIn below the pre-roll");
    this.hold = Array.from({ length: s.channels }, () => new Float32Array(holdFrames));
  }

  /** Restarts at a new position; `pre` frames of earlier input come first (0…`preroll`). */
  begin(pre: number): void {
    this.pre = Math.max(0, Math.min(this.preroll, Math.floor(pre)));
    this.held = 0;
    this.started = false;
    this.inTotal = 0;
    this.outTotal = 0;
    this.discard = this.s.outputLatency;
  }

  /**
   * Feeds `frames` frames of planar input (`data[c]` from `offset`) and returns the output it
   * yields (fresh arrays, possibly empty). Channels beyond `data.length` repeat the last one.
   */
  push(data: readonly Float32Array[], offset: number, frames: number): Float32Array[] {
    const parts: Float32Array[][] = [];
    let at = offset;
    let left = frames;
    if (!this.started) {
      const need = this.pre + this.s.inputLatency;
      const n = Math.min(left, need - this.held);
      this.hold.forEach((h, c) => {
        h.set(channel(data, c).subarray(at, at + n), this.held);
      });
      this.held += n;
      at += n;
      left -= n;
      if (this.held < need) return this.hold.map(() => new Float32Array(0));
      this.s.reset();
      this.hold.forEach((h, c) => {
        this.s.input(c).set(h.subarray(0, need));
      });
      this.s.seek(need, this.rate);
      this.started = true;
    }
    while (left > 0) {
      const maxInForOut = Math.floor(this.s.maxOut * this.rate) - 1;
      const n = Math.max(1, Math.min(left, this.s.maxIn, maxInForOut));
      const target = Math.floor((this.inTotal + n) / this.rate);
      const out = target - this.outTotal;
      for (let c = 0; c < this.s.channels; c++) {
        this.s.input(c).set(channel(data, c).subarray(at, at + n));
      }
      this.s.process(n, out);
      this.inTotal += n;
      this.outTotal = target;
      at += n;
      left -= n;
      const skip = Math.min(this.discard, out);
      this.discard -= skip;
      if (out > skip) {
        parts.push(this.hold.map((_, c) => this.s.output(c).slice(skip, out)));
      }
    }
    return concat(parts, this.s.channels);
  }
}

function channel(data: readonly Float32Array[], c: number): Float32Array {
  const d = data[Math.min(c, data.length - 1)];
  if (!d) throw new RangeError("stretch: no input channels");
  return d;
}

function concat(parts: Float32Array[][], channels: number): Float32Array[] {
  const [first] = parts;
  if (parts.length === 1 && first) return first;
  const total = parts.reduce((n, p) => n + (p[0]?.length ?? 0), 0);
  const result = Array.from({ length: channels }, () => new Float32Array(total));
  let pos = 0;
  for (const part of parts) {
    part.forEach((d, c) => result[c]?.set(d, pos));
    pos += part[0]?.length ?? 0;
  }
  return result;
}
