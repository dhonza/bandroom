/**
 * Decoded PCM waiting in the mixer, in playback order. A chunk is addressed by its lap (loop
 * repeat, 0 without a loop) and its timeline frame, so after a loop wrap the next lap's copy of
 * the loop start sorts after the current lap's tail.
 */
export interface Chunk {
  lap: number;
  frame: number;
  length: number;
  /** 1 (mono) or 2 channels. */
  data: Float32Array[];
}

/** True when `[lapA, frameEndA)` ends at or before `(lap, frame)` in playback order. */
function endsBefore(lapA: number, frameEndA: number, lap: number, frame: number): boolean {
  return lapA < lap || (lapA === lap && frameEndA <= frame);
}

export class ChunkQueue {
  private items: (Chunk | undefined)[] = [];
  private head = 0;

  push(c: Chunk): void {
    this.items.push(c);
  }

  /** Empties the queue in place (it also runs from the render loop). */
  clear(): void {
    this.items.length = 0;
    this.head = 0;
  }

  get size(): number {
    return this.items.length - this.head;
  }

  /**
   * Copies `[frame, frame + n)` of `lap` into `out0/out1` at `offset` (mono duplicated to both);
   * gaps are left untouched. Returns the number of frames that had no data.
   */
  read(
    lap: number,
    frame: number,
    n: number,
    out0: Float32Array,
    out1: Float32Array,
    offset: number,
  ): number {
    let covered = 0;
    const end = frame + n;
    for (let i = this.head; i < this.items.length; i++) {
      const c = this.items[i];
      if (!c) continue;
      if (c.lap > lap || (c.lap === lap && c.frame >= end)) break;
      if (endsBefore(c.lap, c.frame + c.length, lap, frame)) continue;
      const from = Math.max(frame, c.frame);
      const to = Math.min(end, c.frame + c.length);
      const d0 = c.data[0];
      const d1 = c.data[1] ?? d0;
      if (!d0 || !d1) continue;
      for (let f = from; f < to; f++) {
        const s = f - c.frame;
        const o = offset + f - frame;
        out0[o] = d0[s] ?? 0;
        out1[o] = d1[s] ?? 0;
      }
      covered += to - from;
    }
    return n - covered;
  }

  /** True when `[from, to)` of `lap` is fully present. */
  covers(lap: number, from: number, to: number): boolean {
    let next = from;
    for (let i = this.head; i < this.items.length && next < to; i++) {
      const c = this.items[i];
      if (!c) continue;
      if (c.lap > lap) break;
      if (c.lap < lap || c.frame + c.length <= next) continue;
      if (c.frame > next) return false;
      next = c.frame + c.length;
    }
    return next >= to;
  }

  /**
   * Live loop change (SPEC §6.6): chunks of laps up to `maxLap` move by `delta` laps (a fresh
   * base), later laps (decoded for the old loop) are dropped. Playback order is kept because
   * chunks are queued in order. Runs in the command handler, not in the render loop.
   */
  relabel(maxLap: number, delta: number): void {
    for (let i = this.head; i < this.items.length; i++) {
      const c = this.items[i];
      if (!c) continue;
      if (c.lap > maxLap) {
        this.items.length = i;
        break;
      }
      c.lap += delta;
    }
  }

  /** Drops chunks that end at or before `(lap, frame)`. Allocation-free (render loop). */
  prune(lap: number, frame: number): void {
    const items = this.items;
    while (this.head < items.length) {
      const c = items[this.head];
      if (!c || !endsBefore(c.lap, c.frame + c.length, lap, frame)) break;
      items[this.head] = undefined;
      this.head++;
    }
    if (this.head > 256 && this.head * 2 > items.length) {
      // Compact in place: the live tail moves to the front.
      const n = items.length - this.head;
      for (let i = 0; i < n; i++) items[i] = items[this.head + i];
      items.length = n;
      this.head = 0;
    }
  }
}
