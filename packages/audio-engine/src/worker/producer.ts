import { CHUNK_FRAMES } from "../constants";
import {
  FlacStream,
  flacSourceStart,
  OpusStream,
  type FlacCodec,
  type OpusCodec,
  type PcmBlock,
  type StreamDecoder,
} from "../decode/streams";
import { flacSeekPoint, opusSeekPoint, type SeekIndex } from "../decode/seek";
import { addClip, trackLayout, unityEnvelope, upmixGain, type TrackLayout } from "../clips";
import { FADE_FRAMES, type ClipRange } from "../mixer/types";
import type { Chunk } from "../mixer/queue";
import type { StretchModule } from "@bandroom/stretch";
import type { EngineClip, EngineVariant } from "../types";
import { WINDOW_BLOCK, type FileFetcher } from "./bytes";

export interface ProducerDeps {
  file(variant: EngineVariant): FileFetcher;
  seekIndex(variant: EngineVariant): Promise<SeekIndex | null>;
  opusCodec(channels: number): Promise<OpusCodec>;
  flacCodec(): Promise<FlacCodec>;
  /** The stretch WASM module (practice speed/pitch, SPEC §30), loaded on first use. */
  stretch(): Promise<StretchModule>;
  /** Bytes kept per `window`-mode file before blocks away from the cursors are dropped. */
  windowKeepBytes?: number;
}

/** Bytes kept per `window`-mode file before blocks away from the cursors are dropped. */
export const WINDOW_KEEP_BYTES = 16 * 1024 * 1024;
/** Bytes pushed into a decoder per step (~1–2 s of Opus). */
const READ_BYTES = 32 * 1024;

export type StepResult = "produced" | "waiting" | "done";

interface Cursor {
  clip: EngineClip;
  dec: StreamDecoder;
  fetcher: FileFetcher;
  bytePos: number;
  flushed: boolean;
  /** Decoded, not yet emitted; contiguous from `next`. */
  pending: PcmBlock[];
  /** Next source frame to emit. */
  next: number;
}

/**
 * Produces one track's PCM in playback order (SPEC §6.4): from the seek position to the song end,
 * or with a loop, up to the loop end plus the crossfade tail, then lap after lap from the loop
 * start. Gaps between clips are skipped (the mixer knows the clip ranges and plays silence).
 *
 * Clips (SPEC §24.5): one decode cursor per clip playing at the current frame. Each output chunk
 * covers frames where the set of playing clips does not change; every clip's audio is scaled by
 * its gain and fades, up-mixed to the track layout and summed. A single clip without gain or fade
 * there is passed through as decoded (bit-identical, as before clips had envelopes).
 */
export class TrackProducer {
  lap = 0;
  frame = 0;
  private segEnd = 0;
  /** The current segment ends at the loop end (plus tail) and wraps to the loop start. */
  private looped = false;
  /** Decode cursors of the clips playing at `frame` (at most a few, SPEC §24.2). */
  private cursors = new Map<EngineClip, Cursor>();
  /** Clips sorted by start (the order in which they are summed). */
  private readonly sorted: EngineClip[];
  readonly layout: TrackLayout;
  private gen = 0;
  failed: string | null = null;
  /** The mixer keeps the loop region (SPEC §6.4 loop cache); stop after one full lap. */
  cacheOn = false;
  /** One full lap from the loop start was produced; the mixer plays repeats from its cache. */
  cached = false;
  /** The current segment started at the loop start (a full lap if it runs to its end). */
  private fromStart = false;
  /**
   * Emit silence for gaps between and after clips instead of skipping them (a continuous input
   * for a stretcher, see `StretchProducer`).
   */
  fillGaps = false;

  constructor(
    readonly index: number,
    readonly source: number,
    readonly clips: EngineClip[],
    protected readonly deps: ProducerDeps,
    protected readonly emit: (chunk: Chunk) => void,
    protected length: number,
    private loop: ClipRange | null,
  ) {
    this.sorted = clips
      .filter((c) => c.lengthFrames > 0)
      .sort((a, b) => a.startFrame - b.startFrame);
    this.layout = trackLayout(clips);
  }

  /** Production restarts elsewhere (a seek, a new lap number, a dispose): drop work in flight. */
  protected restarted(): void {}

  /** Restarts production at `(lap, frame)`. */
  reset(lap: number, frame: number, loop: ClipRange | null = this.loop): void {
    this.gen++;
    this.restarted();
    if (this.failed) {
      // Try again (a seek or a new start): reopen the clips, the fetcher retries.
      this.failed = null;
      this.freeCursors();
    }
    this.loop = loop;
    this.lap = lap;
    this.frame = frame;
    this.startSegment(frame);
    this.fromStart = this.looped && frame === loop?.start;
  }

  /**
   * Live loop change (SPEC §6.6): the mixer continued lap `fromLap` (at `frame`) as lap `base`.
   * Keeps decoding where it is when that data is still valid, so the change needs no rebuffer.
   */
  retime(
    fromLap: number,
    frame: number,
    base: number,
    loop: ClipRange | null,
    cacheOn: boolean,
  ): void {
    const old = this.loop;
    // Where the mixer's copy of lap `fromLap` ends.
    const fromLapEnd =
      this.lap === fromLap ? this.segEnd : old ? Math.min(this.length, old.end + FADE_FRAMES) : 0;
    this.loop = loop;
    this.cacheOn = cacheOn;
    this.cached = false;
    const wraps = loop !== null && frame < loop.end;
    const segEnd = wraps ? Math.min(this.length, loop.end + FADE_FRAMES) : this.length;
    if (this.lap === fromLap && this.frame <= segEnd) {
      // Same data, new lap number and segment end; the decoder cursors carry on.
      this.lap = base;
      this.looped = wraps;
      this.segEnd = segEnd;
      this.fromStart = false;
    } else if (this.lap > fromLap && fromLapEnd <= segEnd) {
      this.restart(base, fromLapEnd, wraps, segEnd);
    } else if (this.lap < fromLap) {
      this.restart(base, frame, wraps, segEnd);
    } else if (loop) {
      // Already decoded past the new loop end: continue with the next lap.
      this.restart(base + 1, loop.start, true, Math.min(this.length, loop.end + FADE_FRAMES));
    }
  }

  private restart(lap: number, frame: number, looped: boolean, segEnd: number) {
    this.gen++;
    this.restarted();
    this.lap = lap;
    this.frame = frame;
    this.looped = looped;
    this.segEnd = segEnd;
    this.fromStart = looped && frame === this.loop?.start;
  }

  private startSegment(frame: number) {
    const l = this.loop;
    this.looped = l !== null && frame < l.end;
    this.segEnd = l && this.looped ? Math.min(this.length, l.end + FADE_FRAMES) : this.length;
  }

  get finished(): boolean {
    return (
      this.failed !== null || (!this.looped && this.frame >= this.segEnd) || this.servedByCache()
    );
  }

  /** Inside a looped segment whose repeats the mixer plays from its loop cache. */
  private servedByCache(): boolean {
    return this.cached && this.looped && this.loop !== null && this.frame >= this.loop.start;
  }

  dispose(): void {
    this.gen++;
    this.restarted();
    this.freeCursors();
  }

  /** Open decode cursors (debug and tests). */
  get cursorCount(): number {
    return this.cursors.size;
  }

  private freeCursors() {
    for (const c of this.cursors.values()) c.dec.free();
    this.cursors.clear();
  }

  async step(): Promise<StepResult> {
    if (this.failed || this.servedByCache()) return "done";
    if (this.frame >= this.segEnd) {
      if (!this.looped || !this.loop) return "done";
      if (this.cacheOn && this.fromStart) {
        this.cached = true; // the mixer now holds the whole loop region
        return "done";
      }
      this.lap++;
      this.frame = this.loop.start;
      this.startSegment(this.frame);
      this.fromStart = true;
    }
    return this.produce(this.gen, this.segEnd);
  }

  /** The production generation; bumped by every restart (async work checks it). */
  protected get generation(): number {
    return this.gen;
  }

  /** Produces data from `frame` towards the segment end `segEnd` and emits it. */
  protected async produce(gen: number, segEnd: number): Promise<StepResult> {
    const f = this.frame;
    // The clips playing at `f` and where that set changes next.
    const active: EngineClip[] = [];
    let until = segEnd;
    for (const c of this.sorted) {
      const end = c.startFrame + c.lengthFrames;
      if (c.startFrame > f) {
        until = Math.min(until, c.startFrame);
        break; // sorted by start: the rest start later still
      }
      if (end > f) {
        active.push(c);
        until = Math.min(until, end);
      }
    }
    // Cursors of clips that stopped playing (or never will again in this segment) are freed.
    for (const [c, cur] of this.cursors) {
      if (!active.includes(c)) {
        cur.dec.free();
        this.cursors.delete(c);
      }
    }
    if (active.length === 0) {
      if (this.fillGaps) this.emitZeros(this.layout.channels, until);
      else this.frame = until;
      return "produced";
    }
    try {
      const cursors: Cursor[] = [];
      for (const clip of active) {
        const src = clip.sourceOffsetFrame + f - clip.startFrame;
        let cur = this.cursors.get(clip);
        if (!cur || cur.next !== src) {
          cur?.dec.free();
          this.cursors.delete(clip);
          const opened = await this.open(clip, src);
          if (gen !== this.gen) {
            opened.dec.free();
            return "produced";
          }
          this.cursors.set(clip, opened);
          cur = opened;
        }
        cursors.push(cur);
      }
      // Emit while every playing clip has decoded data; else decode the first one short of it.
      let emitted = false;
      while (this.frame < until) {
        let n = Math.min(CHUNK_FRAMES, until - this.frame);
        for (const cur of cursors) {
          const avail = available(cur, n);
          if (avail === 0) return emitted ? "produced" : await this.decode(cur);
          n = Math.min(n, avail);
        }
        this.emitMix(active, cursors, n);
        emitted = true;
      }
      return "produced";
    } catch (err) {
      this.failed = err instanceof Error ? err.message : String(err);
      return "done";
    }
  }

  /** Decodes the next bytes of a cursor (one read per step). */
  private async decode(cur: Cursor): Promise<StepResult> {
    const file = cur.fetcher.file;
    const bytes = file.readAt(cur.bytePos, READ_BYTES);
    // Decoded blocks go to the cursor even when a reset happened meanwhile: its bytes are
    // consumed, and a reset that keeps the cursor (same position) still needs them.
    if (bytes) {
      cur.bytePos += bytes.length;
      // FLAC (and Opus read in windows) is not kept for the whole file (SPEC §6.4).
      if (cur.fetcher.mode === "window") this.evict(cur.fetcher);
      cur.pending.push(...(await cur.dec.push(bytes)));
    } else if (file.size !== null && cur.bytePos >= file.size) {
      cur.flushed = true;
      cur.pending.push(...(await cur.dec.flush()));
    } else {
      cur.fetcher.want(cur.bytePos);
      // Transient errors are retried by the fetcher; only a final one fails the track.
      if (cur.fetcher.error) throw cur.fetcher.error;
      return "waiting";
    }
    return "produced";
  }

  /**
   * Above the keep limit, drops a window file's blocks away from this track's cursors on it: one
   * block behind each cursor and two ahead (the one being read and the next) stay.
   */
  private evict(fetcher: FileFetcher) {
    const file = fetcher.file;
    if (file.stored <= (this.deps.windowKeepBytes ?? WINDOW_KEEP_BYTES)) return;
    const keep: { start: number; end: number }[] = [];
    for (const c of this.cursors.values()) {
      if (c.fetcher === fetcher)
        keep.push({ start: c.bytePos - WINDOW_BLOCK, end: c.bytePos + 2 * WINDOW_BLOCK });
    }
    file.retain(keep);
  }

  /** Emits up to `n` frames of the playing clips: passed through, or mixed. */
  private emitMix(active: EngineClip[], cursors: Cursor[], n: number) {
    const f = this.frame;
    const layout = this.layout;
    const only = active.length === 1 ? active[0] : undefined;
    const cur = cursors[0];
    if (only && cur && only.variant.channels === layout.channels && unityEnvelope(only, f, f + n)) {
      const b = cur.pending[0];
      const off = b ? cur.next - b.frame : -1;
      const len = b?.data[0]?.length ?? 0;
      if (b && off >= 0 && off < len) {
        // One clip at unity: passed through as decoded, up to the end of the decoded block.
        const k = Math.min(n, len - off);
        const data = b.data.map((d) => d.slice(off, off + k));
        this.emit({ lap: this.lap, frame: f, length: k, data });
        advance(cur, k);
        this.frame += k;
        return;
      }
    }
    const data = Array.from({ length: layout.channels }, () => new Float32Array(n));
    active.forEach((clip, i) => {
      const c = cursors[i];
      if (!c) return;
      const up = upmixGain(clip, layout);
      read(c, n, (src, srcOff, k, at) => {
        addClip(data, at, src, srcOff, k, clip, f + at, up);
      });
    });
    this.emit({ lap: this.lap, frame: f, length: n, data });
    this.frame += n;
  }

  private async open(clip: EngineClip, src: number): Promise<Cursor> {
    const v = clip.variant;
    const fetcher = this.deps.file(v);
    if (fetcher.error) fetcher.retry(); // failed for good earlier: a new start tries again
    const index = src > 0 ? await this.deps.seekIndex(v) : null;
    let dec: StreamDecoder;
    let bytePos: number;
    if (v.kind === "opus") {
      const point =
        src > 0 && index
          ? opusSeekPoint(index, v.preSkip, src)
          : { byteOffset: 0, startDecoded: 0 };
      dec = new OpusStream(
        await this.deps.opusCodec(v.channels),
        { channels: v.channels, preSkip: v.preSkip, totalSamples: v.totalFrames },
        point.startDecoded,
        src,
      );
      bytePos = point.byteOffset;
    } else {
      const point = flacSeekPoint(index ?? [], flacSourceStart(src, v.sampleRate));
      dec = new FlacStream(
        await this.deps.flacCodec(),
        { sampleRate: v.sampleRate, channels: v.channels, totalFrames: v.totalFrames },
        point.frame,
        src,
      );
      bytePos = point.byteOffset;
    }
    fetcher.want(bytePos);
    return { clip, dec, fetcher, bytePos, flushed: false, pending: [], next: src };
  }

  /** Emits up to one chunk of silence towards `to`; returns its length. */
  protected emitZeros(channels: number, to: number): number {
    const n = Math.min(CHUNK_FRAMES, to - this.frame);
    if (n <= 0) return 0;
    this.emit({
      lap: this.lap,
      frame: this.frame,
      length: n,
      data: Array.from({ length: channels }, () => new Float32Array(n)),
    });
    this.frame += n;
    return n;
  }
}

/**
 * Frames (up to `max`) a cursor can deliver from `next` without decoding more: its decoded blocks
 * (a hole in them counts as silence), or anything once the decoder ran dry (silence to the end).
 */
function available(cur: Cursor, max: number): number {
  let pos = cur.next;
  for (const b of cur.pending) {
    const end = b.frame + (b.data[0]?.length ?? 0);
    if (end <= pos) continue;
    pos = end; // a block starting after `pos` leaves a hole, played as silence
    if (pos - cur.next >= max) return max;
  }
  if (cur.flushed) return max;
  return Math.min(max, pos - cur.next);
}

/**
 * Walks `n` frames of a cursor from `next`: `fn(data, offset, frames, at)` for each decoded piece
 * (`at` = frames from the start); holes and frames past the decoder's end are skipped (silence).
 * Consumed blocks are dropped.
 */
function read(
  cur: Cursor,
  n: number,
  fn: (data: Float32Array[], offset: number, frames: number, at: number) => void,
) {
  let done = 0;
  while (done < n) {
    const b = cur.pending[0];
    if (!b) break;
    const len = b.data[0]?.length ?? 0;
    const off = cur.next + done - b.frame;
    if (off >= len) {
      cur.pending.shift();
      continue;
    }
    if (off < 0) {
      done = Math.min(n, done - off); // hole up to the block start
      continue;
    }
    const k = Math.min(len - off, n - done);
    fn(b.data, off, k, done);
    done += k;
  }
  advance(cur, n);
}

/** Moves a cursor `n` frames on, dropping the blocks it passed. */
function advance(cur: Cursor, n: number) {
  cur.next += n;
  while (cur.pending.length > 0) {
    const b = cur.pending[0];
    if (!b || b.frame + (b.data[0]?.length ?? 0) > cur.next) break;
    cur.pending.shift();
  }
}

/**
 * Frames between the playhead and a producer cursor in playback order (negative when the cursor
 * is behind).
 */
export function framesAhead(
  playLap: number,
  playFrame: number,
  lap: number,
  frame: number,
  loop: ClipRange | null,
): number {
  if (lap === playLap) return frame - playFrame;
  if (lap < playLap || !loop) return -Infinity;
  const len = loop.end - loop.start;
  return loop.end - playFrame + (lap - playLap - 1) * len + (frame - loop.start);
}
