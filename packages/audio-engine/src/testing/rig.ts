import { createFlacCodec, createOpusCodec } from "../decode/wasm";
import type { FlacCodec } from "../decode/streams";
import { trackLayout } from "../clips";
import { applyMixerCommand } from "../mixer/apply";
import { MixerCore, type MixerEvent, type MixerTrackConfig } from "../mixer/core";
import { loadStretch } from "@bandroom/stretch/node";
import { mixerClips, playbackLength, workerStretch } from "../practice";
import type { EngineClip, EnginePractice, TrackStretchPolicy } from "../types";
import type { FetchLike } from "../worker/bytes";
import { DecodeScheduler } from "../worker/scheduler";

/**
 * Decoder worker + mixer end to end in Node (in-memory HTTP, real WASM decoders, the scheduler
 * and the mixer core); rendering is paced by the decoder, not by a clock.
 */

/** Output recorded per timeline position (lap, frame) → samples of channel `ch`. */
export class Rig {
  events: MixerEvent[] = [];
  core = new MixerCore((e) => {
    this.events.push(structuredClone(e));
    // The worklet forwards loop changes to the decoder worker.
    if (e.type === "retime") this.sched.retime(e.fromLap, e.frame, e.base, e.loop, e.cache);
  });
  sched: DecodeScheduler;

  /** `fetch` is the in-memory server (wrapped to stall or fail requests). */
  constructor(
    private readonly fetch: FetchLike,
    budget: { cacheBytes: number; minWholeBytes?: number; windowKeepBytes?: number } = {
      cacheBytes: 256 * 1024 * 1024,
    },
    flacCodec: () => Promise<FlacCodec> = createFlacCodec,
  ) {
    this.sched = new DecodeScheduler(
      {
        fetch: (url, init) => this.fetch(url, init),
        opusCodec: createOpusCodec,
        flacCodec,
        stretch: loadStretch,
        toMixer: (msg) => {
          applyMixerCommand(this.core, msg);
        },
        toMain: (msg) => {
          if (msg.t === "error") this.errors.push(msg.index);
        },
        yieldNow: () => new Promise((r) => setTimeout(r, 0)),
        retry: { baseMs: 10, attempts: 3 },
        ...(budget.minWholeBytes !== undefined ? { minWholeBytes: budget.minWholeBytes } : {}),
        ...(budget.windowKeepBytes !== undefined
          ? { windowKeepBytes: budget.windowKeepBytes }
          : {}),
      },
      budget.cacheBytes,
      4 * 48_000,
    );
  }

  /** Lap → what was heard over the recorded range (index 0 = `recorded.start`). */
  heard = new Map<number, { l: Float32Array; r: Float32Array }>();
  /** Timeline range recorded into `heard` (default: the whole song). */
  recorded = { start: 0, end: 0 };
  /** Tracks the decoder reported as failed. */
  errors: number[] = [];
  private length = 0;

  /** Loads tracks; with `practice`, positions are playback frames (the engine converts). */
  load(
    clips: EngineClip[][],
    practice?: EnginePractice,
    opts: { policies?: TrackStretchPolicy[]; muted?: boolean[] } = {},
  ) {
    const timeline = Math.max(...clips.flat().map((c) => c.startFrame + c.lengthFrames));
    this.length = playbackLength(timeline, practice?.rate ?? 1);
    const stretches = clips.map((cs, i) =>
      practice
        ? workerStretch(practice, opts.policies?.[i], opts.muted?.[i] ?? false, cs, timeline)
        : null,
    );
    const mixer: MixerTrackConfig[] = clips.map((cs, i) => ({
      id: `t${i}`,
      source: 1,
      ...trackLayout(cs),
      clips: mixerClips(cs, stretches[i], this.length),
      gainDb: 0,
      pan: 0,
      mute: opts.muted?.[i] ?? false,
      solo: false,
    }));
    this.heard.clear();
    this.recorded = { start: 0, end: this.length };
    this.sched.load(
      1,
      clips.map((cs, index) => ({ index, source: 1, clips: cs, stretch: stretches[index] })),
      this.length,
      mixer,
    );
    this.core.startFrames = 24_000;
  }

  seek(frame: number, lap: number) {
    this.sched.seek(frame, lap);
    this.core.seek(frame, lap);
  }

  /** Renders until `frames` were played (paced by the decoder), recording what was heard. */
  async play(frames: number, timeoutMs = 60_000) {
    this.core.play();
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    const deadline = Date.now() + timeoutMs;
    let played = 0;
    while (played < frames) {
      if (Date.now() > deadline) throw new Error(`timeout after ${played} frames`);
      const pos = this.core.position;
      if (pos.state === "stopped") break;
      // Producers stop short of a full window; near the end every remaining frame is needed.
      const need = Math.min(this.sched.windowFrames - 2048, this.length - pos.frame);
      const ahead = this.sched.ahead().filter((_, i) => !this.errors.includes(i));
      if (pos.state === "playing" && Math.min(...ahead) < need) {
        await new Promise((res) => setTimeout(res, 1));
        continue;
      }
      if (pos.state === "buffering") await new Promise((res) => setTimeout(res, 1));
      this.core.mixBlock(l, r, 128, 0);
      const after = this.core.position;
      if (pos.state === "playing" && after.lap === pos.lap) {
        const n = Math.min(128, after.frame - pos.frame);
        const { start, end } = this.recorded;
        const a = Math.max(pos.frame, start);
        const b = Math.min(pos.frame + n, end);
        if (b > a) {
          let buf = this.heard.get(pos.lap);
          if (!buf) {
            buf = { l: new Float32Array(end - start), r: new Float32Array(end - start) };
            this.heard.set(pos.lap, buf);
          }
          buf.l.set(l.subarray(a - pos.frame, b - pos.frame), a - start);
          buf.r.set(r.subarray(a - pos.frame, b - pos.frame), a - start);
        }
        played += n;
      }
      this.sched.position(after.frame, after.lap);
    }
  }

  /** Records only `[start, end)` from now on (long songs); clears what was heard. */
  record(start: number, end: number) {
    this.heard.clear();
    this.recorded = { start, end };
  }

  /** The sample heard at timeline frame `frame` of `lap` (0 when not recorded). */
  at(lap: number, ch: "l" | "r", frame: number): number {
    return this.heard.get(lap)?.[ch][frame - this.recorded.start] ?? 0;
  }

  peak(lap: number, ch: "l" | "r", around: number, window = 300): number {
    const buf = this.heard.get(lap)?.[ch];
    if (!buf) return -1;
    let best = -1;
    let bestAbs = -1;
    for (let i = around - window; i < around + window; i++) {
      const a = Math.abs(buf[i - this.recorded.start] ?? 0);
      if (a > bestAbs) {
        bestAbs = a;
        best = i;
      }
    }
    return best;
  }

  get underruns() {
    return this.events.flatMap((e) =>
      e.type === "report" ? [...e.underruns].filter((frames) => frames > 0) : [],
    );
  }

  dispose() {
    this.sched.dispose();
  }
}
