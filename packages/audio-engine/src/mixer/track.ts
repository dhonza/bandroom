import { LoopCache } from "./loopCache";
import { ChunkQueue } from "./queue";
import { FADE_FRAMES, type ClipRange, type MixerTrackConfig, type TrackParams } from "./types";

/**
 * Per-track mixer state and the allocation-free helpers the render loop runs on it. Free
 * functions over the concrete `Track` type keep the hot path monomorphic.
 */

export interface Track {
  id: string;
  params: TrackParams;
  active: number;
  queue: ChunkQueue;
  /** Pans with the mono equal-power law: one channel, not dual-mono (SPEC §6.6). */
  mono: boolean;
  clips: ClipRange[];
  pending: number; // -1 when none
  pendingQueue: ChunkQueue;
  pendingMono: boolean;
  pendingClips: ClipRange[];
  /** Loudness offset and version gain that take effect with the pending source. */
  pendingOffsetDb: number;
  pendingTrimDb: number;
  /** Decoded loop region of the active and of the pending source (SPEC §6.4). */
  cache: LoopCache;
  pendingCache: LoopCache;
  /** Remaining frames of the old→new version crossfade (0 when none). */
  switchFade: number;
  // Gain ramps per output channel.
  cur0: number;
  cur1: number;
  step0: number;
  step1: number;
  rampLeft: number;
  target0: number;
  target1: number;
  peak: number;
  underrun: number;
  /** The decoder failed to produce this track; it neither blocks buffering nor counts underruns. */
  failed: boolean;
}

export const newTrack = (c: MixerTrackConfig): Track => ({
  id: c.id,
  params: {
    gainDb: c.gainDb,
    pan: c.pan,
    mute: c.mute,
    solo: c.solo,
    offsetDb: 0,
    trimDb: c.trimDb ?? 0,
  },
  active: c.source,
  queue: new ChunkQueue(),
  mono: c.channels === 1 && !c.dualMono,
  clips: c.clips,
  pending: -1,
  pendingQueue: new ChunkQueue(),
  pendingMono: false,
  pendingClips: [],
  pendingOffsetDb: 0,
  pendingTrimDb: 0,
  cache: new LoopCache(),
  pendingCache: new LoopCache(),
  switchFade: 0,
  cur0: 0,
  cur1: 0,
  step0: 0,
  step1: 0,
  rampLeft: 0,
  target0: 0,
  target1: 0,
  peak: 0,
  underrun: 0,
  failed: false,
});

const NO_CLIPS: ClipRange[] = [];

export function inClips(clips: ClipRange[], from: number, to: number): number {
  let n = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (c) n += Math.max(0, Math.min(to, c.end) - Math.max(from, c.start));
  }
  return n;
}

/**
 * Reads `[frame, frame + n)` into `out0/out1` (from 0), taking the part inside a complete loop
 * cache from the cache and the rest from the queue. Returns the frames without data.
 */
export function readSplit(
  q: ChunkQueue,
  c: LoopCache,
  lap: number,
  frame: number,
  n: number,
  out0: Float32Array,
  out1: Float32Array,
): number {
  const end = frame + n;
  if (!c.complete || end <= c.start || frame >= c.end) return q.read(lap, frame, n, out0, out1, 0);
  const a = Math.max(frame, c.start);
  const b = Math.min(end, c.end);
  let missing = c.read(a, b - a, out0, out1, a - frame);
  if (a > frame) missing += q.read(lap, frame, a - frame, out0, out1, 0);
  if (end > b) missing += q.read(lap, b, end - b, out0, out1, b - frame);
  return missing;
}

export function coversSplit(
  q: ChunkQueue,
  c: LoopCache,
  lap: number,
  from: number,
  to: number,
): boolean {
  if (!c.complete || to <= c.start || from >= c.end) return q.covers(lap, from, to);
  return (
    (from >= c.start || q.covers(lap, from, c.start)) && (to <= c.end || q.covers(lap, c.end, to))
  );
}

/**
 * Makes the pending source active (old queue and cache recycled as the pending ones, the cache
 * reset to `region`). The caller updates the gain targets afterwards.
 */
export function swapPending(t: Track, region: ClipRange | null): void {
  const q = t.queue;
  t.queue = t.pendingQueue;
  t.pendingQueue = q;
  q.clear();
  const c = t.cache;
  t.cache = t.pendingCache;
  t.pendingCache = c;
  c.reset(region);
  t.active = t.pending;
  t.mono = t.pendingMono;
  t.clips = t.pendingClips;
  t.params.offsetDb = t.pendingOffsetDb;
  t.params.trimDb = t.pendingTrimDb;
  t.pending = -1;
  t.pendingClips = NO_CLIPS;
}

/**
 * Drops queued data before `(lap, frame)`. While `keep` frames of a wrap crossfade (or a count-in
 * fade-out) still read the previous lap's tail past `loop.end`, that tail is kept.
 */
export function pruneTrack(
  t: Track,
  lap: number,
  frame: number,
  keep: number,
  loop: ClipRange | null,
): void {
  if (keep > 0 && loop) {
    t.queue.prune(lap - 1, loop.end + (FADE_FRAMES - keep));
    t.pendingQueue.prune(lap - 1, loop.end);
    return;
  }
  t.queue.prune(lap, frame);
  t.pendingQueue.prune(lap, frame);
}
