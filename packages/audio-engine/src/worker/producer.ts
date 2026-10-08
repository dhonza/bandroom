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
}

/** Bytes kept per `window`-mode file before blocks behind the playhead are dropped. */
const WINDOW_KEEP_BYTES = 16 * 1024 * 1024;
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
 * start. Only clip ranges produce data; gaps are skipped.
 */
export class TrackProducer {
  lap = 0;
  frame = 0;
  private segEnd = 0;
  /** The current segment ends at the loop end (plus tail) and wraps to the loop start. */
  private looped = false;
  private cursor: Cursor | null = null;
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
  ) {}

  /** Production restarts elsewhere (a seek, a new lap number, a dispose): drop work in flight. */
  protected restarted(): void {}

  /** Restarts production at `(lap, frame)`. */
  reset(lap: number, frame: number, loop: ClipRange | null = this.loop): void {
    this.gen++;
    this.restarted();
    if (this.failed) {
      // Try again (a seek or a new start): reopen the clip, the fetcher retries.
      this.failed = null;
      this.cursor?.dec.free();
      this.cursor = null;
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
      // Same data, new lap number and segment end; the decoder cursor carries on.
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
    this.cursor?.dec.free();
    this.cursor = null;
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
    const clip = this.clips.find(
      (c) => c.startFrame <= this.frame && this.frame < c.startFrame + c.lengthFrames,
    );
    if (!clip) {
      const next = this.clips
        .map((c) => c.startFrame)
        .filter((s) => s > this.frame)
        .reduce((a, b) => Math.min(a, b), Infinity);
      const to = Math.min(next, segEnd);
      if (this.fillGaps) this.emitZeros(this.clips[0]?.variant.channels ?? 2, to);
      else this.frame = to;
      return "produced";
    }
    const to = Math.min(segEnd, clip.startFrame + clip.lengthFrames);
    const src = clip.sourceOffsetFrame + this.frame - clip.startFrame;
    try {
      let cur = this.cursor;
      if (!cur || cur.clip !== clip || cur.next !== src) {
        cur?.dec.free();
        this.cursor = null;
        const opened = await this.open(clip, src);
        if (gen !== this.gen) {
          opened.dec.free();
          return "produced";
        }
        this.cursor = cur = opened;
      }
      if (cur.pending.length === 0) {
        if (cur.flushed) {
          // Decoder ran dry before the clip end (shorter file than announced): fill with silence.
          this.emitSilence(clip, to);
          return "produced";
        }
        const bytes = cur.fetcher.file.readAt(cur.bytePos, READ_BYTES);
        // Decoded blocks go to the cursor even when a reset happened meanwhile: its bytes are
        // consumed, and a reset that keeps the cursor (same position) still needs them.
        if (bytes) {
          cur.bytePos += bytes.length;
          // FLAC (and Opus too big to keep whole) is not kept for the whole file (SPEC §6.4).
          const file = cur.fetcher.file;
          if (cur.fetcher.mode === "window" && file.stored > WINDOW_KEEP_BYTES)
            file.evictBefore(cur.bytePos - WINDOW_BLOCK);
          cur.pending.push(...(await cur.dec.push(bytes)));
        } else if (cur.fetcher.file.size !== null && cur.bytePos >= cur.fetcher.file.size) {
          cur.flushed = true;
          cur.pending.push(...(await cur.dec.flush()));
        } else {
          cur.fetcher.want(cur.bytePos);
          // Transient errors are retried by the fetcher; only a final one fails the track.
          if (cur.fetcher.error) throw cur.fetcher.error;
          return "waiting";
        }
        if (gen !== this.gen) return "produced";
      }
      this.drain(cur, to);
      return "produced";
    } catch (err) {
      this.failed = err instanceof Error ? err.message : String(err);
      return "done";
    }
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

  /** Emits pending PCM up to timeline frame `to` in chunks of at most 4096 frames. */
  private drain(cur: Cursor, to: number) {
    const clip = cur.clip;
    while (this.frame < to && cur.pending.length > 0) {
      const b = cur.pending[0];
      if (!b) break;
      const len = b.data[0]?.length ?? 0;
      const off = cur.next - b.frame;
      if (off >= len) {
        cur.pending.shift();
        continue;
      }
      if (off < 0) {
        // Gap in decoder output (should not happen): skip ahead.
        cur.next = b.frame;
        this.frame = clip.startFrame + (b.frame - clip.sourceOffsetFrame);
        continue;
      }
      const n = Math.min(CHUNK_FRAMES, len - off, to - this.frame);
      this.emit({
        lap: this.lap,
        frame: this.frame,
        length: n,
        data: b.data.map((d) => d.slice(off, off + n)),
      });
      cur.next += n;
      this.frame += n;
    }
  }

  private emitSilence(clip: EngineClip, to: number) {
    const n = this.emitZeros(clip.variant.channels, to);
    if (this.cursor) this.cursor.next += n;
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
