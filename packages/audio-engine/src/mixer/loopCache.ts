import type { Chunk } from "./queue";

/** Loop cache budget (SPEC §6.4): decoded PCM of the loop region for all tracks. */
export const LOOP_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Whether the loop region fits the cache: `loopLength × tracks × 2 channels × 4 bytes ≤ 64 MB`
 * (SPEC §6.4; every track counts because muted tracks are decoded too).
 */
export function loopCacheFits(
  loop: { start: number; end: number },
  tracks: number,
  tailFrames: number,
): boolean {
  return (loop.end - loop.start + tailFrames) * tracks * 2 * 4 <= LOOP_CACHE_BYTES;
}

interface Range {
  start: number;
  end: number;
}

/** First frame ≥ `f` that lies inside a clip (or `limit`): gaps between clips have no data. */
function skipGaps(clips: readonly Range[], f: number, limit: number): number {
  let next = limit;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!c) continue;
    if (c.start <= f && f < c.end) return f;
    if (c.start > f && c.start < next) next = c.start;
  }
  return next;
}

/**
 * Decoded PCM of one track's loop region `[start, end)` (loop start to loop end plus the wrap
 * crossfade tail), kept so repeats are free and never underrun (SPEC §6.4). It is filled with the
 * chunks the decoder sends anyway, as one run growing from the loop start; it is lap-agnostic
 * because the audio at a timeline frame is the same on every repeat.
 */
export class LoopCache {
  start = 0;
  end = 0;
  private chunks: Chunk[] = [];
  private filled = 0;
  complete = false;
  private enabled = false;

  /** Starts over for a loop (or disables the cache with `null`). */
  reset(region: Range | null): void {
    this.chunks.length = 0; // in place: also runs from the render loop (version switch)
    this.complete = false;
    this.enabled = region !== null && region.end > region.start;
    this.start = region?.start ?? 0;
    this.end = region?.end ?? 0;
    this.filled = this.start;
  }

  /** Offers a chunk; it is kept when it continues the run from the loop start. */
  add(c: Chunk, clips: readonly Range[]): void {
    if (!this.enabled || this.complete) return;
    this.filled = skipGaps(clips, this.filled, this.end);
    const cEnd = c.frame + c.length;
    if (this.filled < this.end && c.frame <= this.filled && cEnd > this.filled) {
      this.chunks.push(c);
      this.filled = skipGaps(clips, Math.min(this.end, cEnd), this.end);
    }
    if (this.filled >= this.end) this.complete = true;
  }

  /** Bytes held (for tests and the debug state). */
  get bytes(): number {
    let n = 0;
    for (const c of this.chunks) for (const d of c.data) n += d.byteLength;
    return n;
  }

  /**
   * Copies `[frame, frame + n)` (inside the region) into `out0/out1` at `offset`; mono is
   * duplicated. Returns the frames without data (gaps between clips). Allocation-free.
   */
  read(frame: number, n: number, out0: Float32Array, out1: Float32Array, offset: number): number {
    let covered = 0;
    const end = frame + n;
    let last = frame; // chunks overlap slightly at run joins; count each frame once
    // Chunks are in frame order with increasing ends: binary-search the first one that matters.
    let lo = 0;
    let hi = this.chunks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = this.chunks[mid];
      if (m && m.frame + m.length <= frame) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (!c) continue;
      if (c.frame >= end) break;
      const cEnd = c.frame + c.length;
      if (cEnd <= frame) continue;
      const from = Math.max(frame, c.frame);
      const to = Math.min(end, cEnd);
      const d0 = c.data[0];
      const d1 = c.data[1] ?? d0;
      if (!d0 || !d1) continue;
      for (let f = from; f < to; f++) {
        const s = f - c.frame;
        const o = offset + f - frame;
        out0[o] = d0[s] ?? 0;
        out1[o] = d1[s] ?? 0;
      }
      const newFrom = Math.max(from, last);
      if (to > newFrom) {
        covered += to - newFrom;
        last = to;
      }
    }
    return n - covered;
  }
}
