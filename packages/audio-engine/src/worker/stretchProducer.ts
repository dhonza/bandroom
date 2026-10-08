import { createStretch, type StretchStream } from "@bandroom/stretch";
import { CHUNK_FRAMES } from "../constants";
import type { ClipRange } from "../mixer/types";
import type { Chunk } from "../mixer/queue";
import type { EngineClip, WorkerStretch } from "../types";
import { TrackProducer, type ProducerDeps, type StepResult } from "./producer";

/** Output frames queued from the stretcher, starting at playback frame `at`. */
interface Run {
  at: number;
  queue: Float32Array[][];
  /** Read position in `queue[0]`. */
  offset: number;
}

/**
 * A track played through the practice stretcher (SPEC §30.5). Lap, segment, loop and cache logic
 * are the base producer's, in **playback frames** (`p = t / rate`); the content comes from an
 * inner producer that decodes the clips on the timeline (with silence in the gaps, so the
 * stretcher gets continuous input) and is pushed through a `StretchStream`. Every start (a seek,
 * a loop wrap, a restart) primes the stretcher with up to one block + interval of earlier input
 * and the first output frame belongs exactly to the start position.
 */
export class StretchProducer extends TrackProducer {
  private readonly inner: TrackProducer;
  private stream: (StretchStream & { dispose(): void }) | null = null;
  private run: Run | null = null;
  private disposed = false;

  constructor(
    index: number,
    source: number,
    clips: EngineClip[],
    deps: ProducerDeps,
    emit: (chunk: Chunk) => void,
    length: number,
    loop: ClipRange | null,
    private readonly spec: WorkerStretch,
  ) {
    super(index, source, clips, deps, emit, length, loop);
    // Timeline input runs past the song end by the stretcher's latency, so the output reaches
    // the playback length (`ceil(timeline / rate)`); silence fills it.
    const pad = Math.ceil(spec.rate * CHUNK_FRAMES) + 4 * CHUNK_FRAMES;
    this.inner = new TrackProducer(
      index,
      source,
      clips,
      deps,
      (chunk) => {
        this.feed(chunk);
      },
      spec.timelineFrames + pad,
      null,
    );
    this.inner.fillGaps = true;
  }

  protected override restarted(): void {
    this.run = null;
    // Cancels a decode in flight (it must not feed the next run); reopened by the next reset.
    this.inner.dispose();
  }

  override dispose(): void {
    super.dispose();
    this.disposed = true;
    this.stream?.dispose();
    this.stream = null;
  }

  protected override async produce(gen: number, segEnd: number): Promise<StepResult> {
    if (this.run?.at !== this.frame) {
      const started = await this.start(gen);
      if (!started) return "produced";
    }
    const run = this.run;
    if (!run) return "produced";
    if (run.queue.length === 0) {
      if (this.inner.finished) {
        // Past the padded input (should not happen): fill with silence.
        run.at += this.emitZeros(this.spec.channels, segEnd);
        return "produced";
      }
      const r = await this.inner.step();
      if (gen !== this.generation || this.run !== run) return "produced";
      if (this.inner.failed) {
        this.failed = this.inner.failed;
        return "done";
      }
      if (r === "waiting") return "waiting";
    }
    this.drainRun(run, segEnd);
    return "produced";
  }

  /** Starts a run at the current playback frame; false when superseded meanwhile. */
  private async start(gen: number): Promise<boolean> {
    if (!this.stream) {
      const mod = await this.deps.stretch();
      if (gen !== this.generation || this.disposed) return false;
      this.stream ??= createStretch(mod, {
        channels: this.spec.channels,
        rate: this.spec.rate,
        semitones: this.spec.semitones,
        profile: this.spec.profile,
        quality: this.spec.quality,
        voiceBaseHz: this.spec.voiceBaseHz,
        formant: this.spec.formant,
        formantSemitones: this.spec.formantShift,
      });
    }
    const t0 = Math.round(this.frame * this.spec.rate);
    const pre = Math.min(this.stream.preroll, t0);
    this.stream.begin(pre);
    this.inner.reset(0, t0 - pre, null);
    this.run = { at: this.frame, queue: [], offset: 0 };
    return true;
  }

  private feed(chunk: Chunk) {
    const run = this.run;
    const stream = this.stream;
    if (!run || !stream) return;
    const out = stream.push(chunk.data, 0, chunk.length);
    if ((out[0]?.length ?? 0) > 0) run.queue.push(out);
  }

  /** Emits queued output up to `segEnd` in chunks of at most 4096 frames. */
  private drainRun(run: Run, segEnd: number) {
    while (this.frame < segEnd && run.queue.length > 0) {
      const block = run.queue[0];
      const len = block?.[0]?.length ?? 0;
      if (!block || run.offset >= len) {
        run.queue.shift();
        run.offset = 0;
        continue;
      }
      const n = Math.min(CHUNK_FRAMES, len - run.offset, segEnd - this.frame);
      const off = run.offset;
      this.emit({
        lap: this.lap,
        frame: this.frame,
        length: n,
        data: block.map((d) => d.slice(off, off + n)),
      });
      run.offset += n;
      run.at += n;
      this.frame += n;
    }
  }
}

/**
 * A muted track while practice is on (SPEC §30.5): silence instead of stretching it, so muted
 * tracks cost nothing. Unmuting switches the track to a `StretchProducer` (a new source).
 */
export class SilentProducer extends TrackProducer {
  constructor(
    index: number,
    source: number,
    clips: EngineClip[],
    deps: ProducerDeps,
    emit: (chunk: Chunk) => void,
    length: number,
    loop: ClipRange | null,
    private readonly channels: number,
  ) {
    super(index, source, clips, deps, emit, length, loop);
  }

  protected override produce(_gen: number, segEnd: number): Promise<StepResult> {
    this.emitZeros(this.channels, segEnd);
    return Promise.resolve("produced");
  }
}
