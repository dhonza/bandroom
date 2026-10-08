import { SeekIndexSchema } from "@bandroom/shared/audio";
import { SAMPLE_RATE } from "../constants";
import type { SeekIndex } from "../decode/seek";
import type { FlacCodec, OpusCodec } from "../decode/streams";
import type { ClipRange, MixerTrackConfig } from "../mixer/core";
import type { MixerCommand, ToDecoder } from "../mixer/protocol";
import type { StretchModule } from "@bandroom/stretch";
import { mixerClips } from "../practice";
import type {
  EngineClip,
  EngineVariant,
  WorkerEvent,
  WorkerStretch,
  WorkerTrackSpec,
} from "../types";
import { FileFetcher, SparseFile, type FetchLike, type RetryPolicy } from "./bytes";
import { framesAhead, TrackProducer, type ProducerDeps } from "./producer";
import { SilentProducer, StretchProducer } from "./stretchProducer";

export interface SchedulerDeps {
  fetch: FetchLike;
  opusCodec(channels: number): Promise<OpusCodec>;
  flacCodec(): Promise<FlacCodec>;
  /** The stretch WASM module, loaded on first use (practice speed/pitch, SPEC §30). */
  stretch(): Promise<StretchModule>;
  /** To the mixer worklet; `transfer` lists buffers to move. */
  toMixer(msg: MixerCommand, transfer: ArrayBuffer[]): void;
  toMain(msg: WorkerEvent): void;
  /** Yields to the event loop (so commands and position reports get through). */
  yieldNow(): Promise<void>;
  /** Backoff for failed downloads (default: `DEFAULT_RETRY`). */
  retry?: RetryPolicy;
  /** Files up to this size are always kept whole (default 8 MB; tests lower it). */
  minWholeBytes?: number;
}

/** Lead before a version/quality switch takes effect, so the new source is decoded in time. */
const SWITCH_LEAD = Math.round(0.3 * SAMPLE_RATE);
const REPORT_MS = 250;
/** A file always fits whole up to this size, whatever the per-file share of the budget. */
const MIN_WHOLE_BYTES = 8 * 1024 * 1024;
const SLICE_MS = 8;

interface CacheEntry {
  fetcher: FileFetcher;
  used: number;
}

/**
 * The decoder worker's brain (SPEC §6.2, §6.4): owns the compressed-byte LRU cache across songs,
 * one producer per track, and decodes whichever track is closest to running dry until every
 * track is `windowFrames` ahead of the playhead.
 */
export class DecodeScheduler {
  private files = new Map<string, CacheEntry>();
  private indexes = new Map<string, Promise<SeekIndex | null>>();
  private producers: TrackProducer[] = [];
  private waiting = new Set<TrackProducer>();
  /** Bumped whenever `waiting` is cleared (new bytes, a fetch error, a seek). */
  private wakes = 0;
  private length = 0;
  private loop: ClipRange | null = null;
  /** Loop cache on in the mixer (SPEC §6.4). */
  private cache = false;
  private playLap = 0;
  private playFrame = 0;
  private wakeUp: (() => void) | null = null;
  private running = false;
  private disposed = false;
  private lastReport = 0;
  private inUse = new Set<string>();
  /** Per-file share of the budget for the current song (see `applyWholeLimit`). */
  private wholeLimit = Infinity;
  /** The current song load's id (mixer messages about earlier loads are dropped). */
  private loadId = 0;

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly cacheBytes: number,
    readonly windowFrames: number,
  ) {}

  /** Loads a song; the mixer acknowledges load `id` to the main thread. */
  load(
    id: number,
    tracks: WorkerTrackSpec[],
    lengthFrames: number,
    mixer: MixerTrackConfig[],
  ): void {
    for (const p of this.producers) p.dispose();
    this.loadId = id;
    this.length = lengthFrames;
    this.loop = null;
    this.cache = false;
    this.playLap = 0;
    this.playFrame = 0;
    this.deps.toMixer({ t: "load", id, tracks: mixer, lengthFrames }, []);
    this.producers = tracks.map((t) =>
      this.producer(t.index, t.source, t.clips, t.stretch ?? null, 0, 0),
    );
    this.inUse = new Set(tracks.flatMap((t) => t.clips.map((c) => c.variant.hash)));
    for (const [hash, e] of this.files) if (!this.inUse.has(hash)) e.fetcher.stop();
    this.applyWholeLimit();
    for (const t of tracks) for (const c of t.clips) this.fetcher(c.variant).begin();
    this.evict();
    this.kick();
  }

  /**
   * A message from the mixer: playhead reports, seeks and loop changes. Those sent for an earlier
   * song load (still in flight when this one started) are dropped, see `ToDecoder`.
   */
  fromMixer(m: ToDecoder): void {
    if (m.load !== this.loadId) return;
    if (m.t === "pos") this.position(m.frame, m.lap);
    else if (m.t === "seek") this.seek(m.frame, m.lap);
    else this.retime(m.fromLap, m.frame, m.base, m.loop, m.cache);
  }

  unload(): void {
    for (const p of this.producers) p.dispose();
    this.producers = [];
    for (const e of this.files.values()) e.fetcher.stop();
    this.inUse.clear();
  }

  seek(frame: number, lap: number): void {
    this.playLap = lap;
    this.playFrame = frame;
    for (const p of this.producers) p.reset(lap, frame, this.loop);
    this.wake();
    this.kick();
  }

  /**
   * A loop change took effect in the mixer at `(fromLap, frame)`, continuing as lap `base`
   * (SPEC §6.6). Arrives on the mixer port, so it is ordered with seeks and position reports.
   */
  retime(
    fromLap: number,
    frame: number,
    base: number,
    loop: ClipRange | null,
    cache: boolean,
  ): void {
    this.loop = loop;
    this.cache = cache;
    this.playLap = base;
    this.playFrame = frame;
    for (const p of this.producers) p.retime(fromLap, frame, base, loop, cache);
    this.wake();
    this.kick();
  }

  position(frame: number, lap: number): void {
    this.playLap = lap;
    this.playFrame = frame;
    this.kick();
  }

  /** Switches a track to a new source from shortly after the playhead (SPEC §6.5, A/B). */
  setSource(
    index: number,
    source: number,
    clips: EngineClip[],
    offsetDb = 0,
    trimDb = 0,
    stretch: WorkerStretch | null = null,
  ): void {
    const old = this.producers[index];
    if (!old || source <= old.source) return;
    let lap = this.playLap;
    let frame = this.playFrame + SWITCH_LEAD;
    const l = this.loop;
    if (l && this.playFrame < l.end && frame >= l.end) {
      lap++;
      frame = l.start + (frame - l.end);
    }
    const channels = clips[0]?.variant.channels ?? 2;
    const dualMono = clips[0]?.variant.dualMono ?? false;
    this.deps.toMixer(
      {
        t: "source",
        index,
        source,
        channels,
        dualMono,
        clips: mixerClips(clips, stretch, this.length),
        offsetDb,
        trimDb,
      },
      [],
    );
    old.dispose();
    this.waiting.delete(old);
    this.producers[index] = this.producer(
      index,
      source,
      clips,
      stretch,
      lap,
      Math.min(frame, this.length),
    );
    for (const c of clips) this.inUse.add(c.variant.hash);
    this.applyWholeLimit();
    for (const c of clips) this.fetcher(c.variant).begin();
    this.kick();
  }

  dispose(): void {
    this.disposed = true;
    this.unload();
    this.kick();
  }

  /** Frames buffered ahead of the playhead per track (capped at the window). */
  ahead(): number[] {
    return this.producers.map((p) =>
      p.failed
        ? 0
        : p.finished
          ? this.windowFrames
          : Math.max(
              0,
              Math.min(
                this.windowFrames,
                framesAhead(this.playLap, this.playFrame, p.lap, p.frame, this.loop),
              ),
            ),
    );
  }

  private producer(
    index: number,
    source: number,
    clips: EngineClip[],
    stretch: WorkerStretch | null,
    lap: number,
    frame: number,
  ) {
    const deps: ProducerDeps = {
      file: (v) => this.fetcher(v),
      seekIndex: (v) => this.seekIndex(v),
      opusCodec: (ch) => this.deps.opusCodec(ch),
      flacCodec: () => this.deps.flacCodec(),
      stretch: () => this.deps.stretch(),
    };
    const emit = (chunk: { lap: number; frame: number; data: Float32Array[] }) => {
      this.deps.toMixer(
        { t: "chunk", index, source, lap: chunk.lap, frame: chunk.frame, data: chunk.data },
        chunk.data.map((d) => d.buffer as ArrayBuffer),
      );
    };
    const p = !stretch
      ? new TrackProducer(index, source, clips, deps, emit, this.length, this.loop)
      : stretch.silent
        ? new SilentProducer(
            index,
            source,
            clips,
            deps,
            emit,
            this.length,
            this.loop,
            stretch.channels,
          )
        : new StretchProducer(index, source, clips, deps, emit, this.length, this.loop, stretch);
    p.cacheOn = this.cache;
    p.reset(lap, frame, this.loop);
    return p;
  }

  private fetcher(v: EngineVariant): FileFetcher {
    let e = this.files.get(v.hash);
    if (!e) {
      const fetcher = new FileFetcher(
        v.url,
        new SparseFile(),
        v.kind === "opus" ? "whole" : "window",
        this.deps.fetch,
        () => {
          this.wake();
          this.kick();
        },
        this.deps.retry,
      );
      fetcher.wholeLimit = this.wholeLimit;
      e = { fetcher, used: 0 };
      this.files.set(v.hash, e);
    }
    e.used = Date.now();
    // Stopped when another song was loaded; it is wanted again now.
    e.fetcher.resume();
    return e.fetcher;
  }

  /**
   * The current song's files share the compressed-byte budget (SPEC §6.4): an Opus file bigger
   * than its share (a long recording) is read in windows instead of being kept whole.
   */
  private applyWholeLimit() {
    const limit = Math.max(
      this.deps.minWholeBytes ?? MIN_WHOLE_BYTES,
      Math.floor(this.cacheBytes / Math.max(1, this.inUse.size)),
    );
    for (const hash of this.inUse) {
      const e = this.files.get(hash);
      if (e) e.fetcher.wholeLimit = limit;
    }
    this.wholeLimit = limit;
  }

  /** LRU across songs; files of the current song are never evicted. */
  private evict() {
    let total = 0;
    for (const e of this.files.values()) total += e.fetcher.file.stored;
    const idle = [...this.files.entries()]
      .filter(([h]) => !this.inUse.has(h))
      .sort((a, b) => a[1].used - b[1].used);
    for (const [hash, e] of idle) {
      if (total <= this.cacheBytes) break;
      total -= e.fetcher.file.stored;
      e.fetcher.stop();
      this.files.delete(hash);
    }
  }

  /**
   * The variant's seek index, or null without one (decoding then starts at the file start). Only
   * a valid index and a 404 are cached: a failed fetch is tried again by the next open (seek).
   */
  private seekIndex(v: EngineVariant): Promise<SeekIndex | null> {
    const url = v.seekIndexUrl;
    if (!url) return Promise.resolve(null);
    let p = this.indexes.get(url);
    if (!p) {
      const loading: Promise<SeekIndex | null> = this.fetchSeekIndex(url).catch(() => {
        if (this.indexes.get(url) === loading) this.indexes.delete(url);
        return null;
      });
      if (this.indexes.size > 500) this.indexes.clear();
      this.indexes.set(url, loading);
      p = loading;
    }
    return p;
  }

  private async fetchSeekIndex(url: string): Promise<SeekIndex | null> {
    const res = await this.deps.fetch(url, {});
    if (res.status === 404) return null;
    if (res.status !== 200 || !res.body) throw new Error(`HTTP ${res.status}`);
    const text = await new Response(res.body).text();
    return SeekIndexSchema.parse(JSON.parse(text));
  }

  private kick() {
    const w = this.wakeUp;
    this.wakeUp = null;
    w?.();
    if (!this.running && !this.disposed) {
      this.running = true;
      void this.run();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = null;
        resolve();
      }, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** Producers waiting for bytes get another try. */
  private wake() {
    this.wakes++;
    this.waiting.clear();
  }

  /** Most urgent producer that is below the window and not waiting for bytes. */
  private pick(): TrackProducer | null {
    let best: TrackProducer | null = null;
    let bestAhead = Infinity;
    for (const p of this.producers) {
      if (p.finished || this.waiting.has(p)) continue;
      let ahead = framesAhead(this.playLap, this.playFrame, p.lap, p.frame, this.loop);
      if (ahead < 0) {
        // Fell behind the playhead (underrun): continue from where it is now.
        p.reset(this.playLap, this.playFrame, this.loop);
        ahead = 0;
      }
      if (ahead >= this.windowFrames) continue;
      if (ahead < bestAhead) {
        best = p;
        bestAhead = ahead;
      }
    }
    return best;
  }

  private async run() {
    let slice = Date.now();
    try {
      while (!this.disposed) {
        const now = Date.now();
        if (now - this.lastReport >= REPORT_MS) {
          this.lastReport = now;
          if (this.producers.length > 0) this.deps.toMain({ t: "buffer", ahead: this.ahead() });
        }
        const p = this.pick();
        if (!p) {
          await this.sleep(REPORT_MS);
          slice = Date.now();
          if (this.producers.length === 0) break;
          continue;
        }
        const wakes = this.wakes;
        const r = await p.step();
        // Bytes or a fetch error that arrived while the step finished must not be missed.
        if (r === "waiting" && wakes === this.wakes) this.waiting.add(p);
        if (p.failed) {
          this.deps.toMain({ t: "error", index: p.index, message: p.failed });
          // The mixer stops waiting for the track (it retries after the next seek).
          this.deps.toMixer({ t: "failed", index: p.index, failed: true }, []);
        }
        if (Date.now() - slice > SLICE_MS) {
          await this.deps.yieldNow();
          slice = Date.now();
        }
      }
    } finally {
      this.running = false;
    }
  }
}
