import { dbToGain } from "@bandroom/shared/audio";
import { SAMPLE_RATE } from "../constants";
import {
  clickSamples,
  ClickVoices,
  firstAtOrAfter,
  type ClickLevel,
  type ClickSampleSet,
  type CountInSpec,
} from "./click";
import { updateTargets } from "./gains";
import type { Chunk } from "./queue";
import {
  coversSplit,
  inClips,
  newTrack,
  pruneTrack,
  readSplit,
  swapPending,
  type Track,
} from "./track";
import {
  DEFAULT_CLICK,
  FADE_FRAMES,
  REPORT_FRAMES,
  type ClickParams,
  type ClipRange,
  type MixerEvent,
  type MixerReport,
  type MixerTrackConfig,
  type TrackParams,
  type TransportState,
} from "./types";

export * from "./types";

/**
 * The mixer (SPEC §6.2, §6.5, §6.6) as plain logic, so it runs unchanged in the AudioWorklet and
 * in Node tests. `mixBlock` is allocation-free: scratch buffers are sized in the command handlers
 * (`load`, a larger block) and reused, and the events it emits are preallocated objects that the
 * receiver must copy (the worklet's `postMessage` clones them).
 *
 * Positions are (lap, frame) pairs. `frame` is the timeline frame at 48 kHz; `lap` orders data in
 * playback order: each seek starts a new lap base (`seekLap`), each loop wrap adds 1. Chunks from
 * before a seek therefore sort before the new position and are pruned after the jump.
 */

const STATE_EVENTS: Record<TransportState, MixerEvent> = {
  stopped: { type: "state", state: "stopped" },
  buffering: { type: "state", state: "buffering" },
  playing: { type: "state", state: "playing" },
};
const ENDED: MixerEvent = { type: "ended" };

export class MixerCore {
  private tracks: Track[] = [];
  private length = 0;
  private state: TransportState = "stopped";
  private frame = 0;
  private lap = 0;
  private loop: ClipRange | null = null;
  /** Keep the loop region's PCM (it fits the budget; decided by the engine). */
  private cacheOn = false;
  /** Lap relabelings from live loop changes, applied to chunks still in flight (oldest first). */
  private remaps: { from: number; to: number }[] = [];
  /** Transport fade gain and its direction (+1 in, −1 out, 0 steady). */
  private fade = 0;
  private fadeDir = 0;
  private pendingSeek: { frame: number; lap: number } | null = null;
  private pendingStop = false;
  /** Remaining frames of the loop-wrap crossfade. */
  private wrapFade = 0;
  private sinceReport = 0;
  private master0 = 0;
  private master1 = 0;
  /** Frames that must be buffered before playback (re)starts. */
  startFrames = SAMPLE_RATE;

  // ——— click and count-in (SPEC §6.7) ———
  private clickFrames: Float64Array = new Float64Array(0);
  private clickLevels: Uint8Array = new Uint8Array(0);
  private click: ClickParams = { ...DEFAULT_CLICK };
  private samples: ClickSampleSet = clickSamples(DEFAULT_CLICK.sound);
  private clickGain = 1;
  private anyTrackSolo = false;
  private voices = new ClickVoices();
  /** Count-in for the next start from `stopped` (consumed when playback begins). */
  private pendingCountIn: CountInSpec | null = null;
  /** Count-in inserted at every loop wrap ("count-in every repeat"), or null. */
  private repeatCountIn: CountInSpec | null = null;
  /** Count-in in progress: frames left, frames done, and its pattern. */
  private preroll = 0;
  private prerollDone = 0;
  private preSpec: CountInSpec | null = null;
  /** Frames of the previous lap's tail still fading out during a repeat count-in. */
  private tailOut = 0;

  private a0 = new Float32Array(128);
  private a1 = new Float32Array(128);
  private b0 = new Float32Array(128);
  private b1 = new Float32Array(128);
  private panOut = { left: 1, right: 1 };
  private report: MixerReport = {
    type: "report",
    frame: 0,
    lap: 0,
    time: 0,
    playing: false,
    preroll: 0,
    prerollInterval: 0,
    prerollClicks: 0,
    clicks: 0,
    peaks: new Float32Array(2),
    underruns: new Float32Array(0),
  };

  constructor(private readonly emit: (e: MixerEvent) => void) {}

  // ——— configuration ————————————————————————————————————————————————

  load(tracks: MixerTrackConfig[], lengthFrames: number): void {
    this.tracks = tracks.map(newTrack);
    this.report.peaks = new Float32Array(tracks.length + 2);
    this.report.underruns = new Float32Array(tracks.length);
    this.length = lengthFrames;
    this.frame = 0;
    this.lap = 0;
    this.loop = null;
    this.cacheOn = false;
    this.remaps = [];
    this.setState("stopped");
    this.fade = 0;
    this.fadeDir = 0;
    this.pendingSeek = null;
    this.pendingStop = false;
    this.wrapFade = 0;
    this.pendingCountIn = null;
    this.preroll = 0;
    this.prerollDone = 0;
    this.preSpec = null;
    this.tailOut = 0;
    this.voices.reset();
    this.voices.count = 0;
    this.updateTargets(true);
  }

  /** The song's click pulses (timeline frames, sorted) and levels; kept across loads. */
  setClickTrack(frames: Float64Array, levels: Uint8Array): void {
    this.clickFrames = frames;
    this.clickLevels = levels;
  }

  setClick(p: Partial<ClickParams>): void {
    const sound = this.click.sound;
    this.click = { ...this.click, ...p };
    if (this.click.sound !== sound) this.samples = clickSamples(this.click.sound);
    this.clickGain = dbToGain(this.click.gainDb);
    this.updateTargets(false);
  }

  get clickParams(): ClickParams {
    return this.click;
  }

  /** "Count-in every repeat" (SPEC §6.7): the gap inserted at each loop wrap, or null. */
  setRepeatCountIn(spec: CountInSpec | null): void {
    this.repeatCountIn = spec && spec.clicks > 0 && spec.intervalFrames > 0 ? spec : null;
  }

  private clickAudible(): boolean {
    const c = this.click;
    return c.enabled && !(c.soloExcludes && this.anyTrackSolo && !c.solo);
  }

  private clickSample(level: number): Float32Array {
    const l = (level === 0 && !this.click.accent ? 1 : Math.min(2, level)) as ClickLevel;
    return this.samples[l];
  }

  private startPreroll(spec: CountInSpec) {
    this.preSpec = spec;
    this.preroll = Math.max(1, Math.round(spec.clicks * spec.intervalFrames));
    this.prerollDone = 0;
  }

  setTrack(index: number, p: Partial<TrackParams>): void {
    const t = this.tracks[index];
    if (!t) return;
    t.params = { ...t.params, ...p };
    // A version gain sent during a version switch belongs to the version being switched to.
    if (p.trimDb !== undefined && t.pending >= 0) t.pendingTrimDb = p.trimDb;
    this.updateTargets(false);
  }

  /** Marks a track as failed by the decoder (cleared by new data, a new source or a seek). */
  setFailed(index: number, failed: boolean): void {
    const t = this.tracks[index];
    if (t) t.failed = failed;
  }

  /**
   * Announces a new source (version or quality switch). While playing, the old source continues
   * until the new one has data, then they crossfade; otherwise the switch is immediate.
   */
  setSource(
    index: number,
    source: number,
    channels: number,
    clips: ClipRange[],
    offsetDb = 0,
    trimDb = 0,
    dualMono = false,
  ): void {
    const t = this.tracks[index];
    if (!t || source === t.active || source <= t.pending) return;
    t.pending = source;
    t.failed = false;
    t.pendingQueue.clear();
    t.pendingCache.reset(this.cacheRegion());
    t.pendingClips = clips;
    t.pendingMono = channels === 1 && !dualMono;
    t.pendingOffsetDb = offsetDb;
    t.pendingTrimDb = trimDb;
    t.switchFade = 0;
    if (this.state !== "playing") this.completeSwitch(t);
  }

  /**
   * Sets or clears the loop, also while playing, without a rebuffer (SPEC §6.6): the current lap
   * continues under the fresh lap base `base`; data already decoded for it stays valid, laps
   * decoded ahead for the old loop are dropped. With `cache`, the loop region's PCM is kept
   * (SPEC §6.4). The decoder worker learns the exact switch point from the `retime` event.
   */
  setLoop(loop: ClipRange | null, base: number, cache = false): void {
    const l = loop && loop.end > loop.start ? { start: loop.start, end: loop.end } : null;
    let fromLap: number;
    let frame: number;
    const ps = this.pendingSeek;
    if (ps) {
      // A seek is fading out: the loop applies from where it lands.
      fromLap = ps.lap;
      frame = ps.frame;
      ps.lap = base;
    } else {
      fromLap = this.lap;
      frame = this.frame;
      for (const t of this.tracks) {
        t.queue.relabel(fromLap, base - fromLap);
        t.pendingQueue.relabel(fromLap, base - fromLap);
      }
      this.lap = base;
    }
    this.remaps.push({ from: fromLap, to: base });
    if (this.remaps.length > 16) this.remaps.shift();
    this.loop = l;
    this.wrapFade = 0; // the old loop's tail no longer applies
    this.cacheOn = cache && l !== null;
    const region = this.cacheRegion();
    for (const t of this.tracks) {
      t.cache.reset(region);
      t.pendingCache.reset(region);
    }
    this.emit({ type: "retime", fromLap, frame, base, loop: l, cache: this.cacheOn });
  }

  /** The cached region: loop start to loop end plus the wrap tail (clamped to the song). */
  private cacheRegion(): ClipRange | null {
    const l = this.loop;
    if (!l || !this.cacheOn) return null;
    return { start: l.start, end: Math.min(this.length, l.end + FADE_FRAMES) };
  }

  addChunk(index: number, source: number, chunk: Chunk): void {
    const t = this.tracks[index];
    if (!t) return;
    // Chunks decoded before the worker saw a loop change carry old lap numbers.
    let lap = chunk.lap;
    for (const r of this.remaps) {
      if (lap >= r.to) continue;
      if (lap > r.from) return; // decoded for the old loop's next laps
      lap += r.to - r.from;
    }
    chunk.lap = lap;
    if (this.cacheOn) {
      if (source === t.active) t.cache.add(chunk, t.clips);
      else if (source === t.pending) t.pendingCache.add(chunk, t.pendingClips);
    }
    if (lap < this.lap - 1) return;
    t.failed = false; // the decoder recovered
    if (source === t.active) t.queue.push(chunk);
    else if (source === t.pending) t.pendingQueue.push(chunk);
  }

  /** Loop-cache state per track (debug state and tests). */
  get loopCache(): { enabled: boolean; complete: boolean[]; bytes: number } {
    return {
      enabled: this.cacheOn,
      complete: this.tracks.map((t) => t.cache.complete),
      bytes: this.tracks.reduce((n, t) => n + t.cache.bytes + t.pendingCache.bytes, 0),
    };
  }

  // ——— transport ————————————————————————————————————————————————————

  /** Starts playback; with `countIn`, the count-in plays first (SPEC §6.7). */
  play(countIn: CountInSpec | null = null): void {
    this.pendingStop = false;
    const ci = countIn && countIn.clicks > 0 && countIn.intervalFrames > 0 ? countIn : null;
    if (this.state === "stopped") {
      // At the song end (and not inside a loop that wraps back): start over.
      if (this.frame >= this.length && !(this.loop && this.frame < this.loop.end)) this.frame = 0;
      this.pendingCountIn = ci;
      this.setState("buffering");
    } else if (this.state === "buffering") {
      this.pendingCountIn = ci;
    } else {
      if (this.fadeDir < 0 && !this.pendingSeek) this.fadeDir = 1; // resume during a fade-out
      // Confirm: the engine may already show "buffering" (resuming after an interruption).
      this.emit({ type: "state", state: this.state });
    }
  }

  pause(): void {
    this.pendingCountIn = null;
    if (this.state === "buffering") this.setState("stopped");
    else if (this.state === "playing" && this.preroll > 0) {
      // Only clicks are sounding: stop right away (they ring out).
      this.preroll = 0;
      this.preSpec = null;
      this.tailOut = 0;
      this.pendingStop = false;
      this.setState("stopped");
    } else if (this.state === "playing") {
      this.pendingStop = true;
      this.fadeDir = -1;
    }
  }

  /** Jumps to `frame`; `lap` must be a fresh base (a multiple of LAPS_PER_SEEK). */
  seek(frame: number, lap: number): void {
    const f = Math.max(0, Math.min(frame, this.length));
    // The decoder retries failed tracks after a seek.
    for (const t of this.tracks) t.failed = false;
    if (this.state === "playing" && this.fade > 0) {
      this.pendingSeek = { frame: f, lap };
      this.fadeDir = -1;
    } else {
      this.jump(f, lap);
      if (this.state === "playing") this.setState("buffering");
    }
  }

  get position(): { frame: number; lap: number; state: TransportState } {
    return { frame: this.frame, lap: this.lap, state: this.state };
  }

  // ——— rendering ————————————————————————————————————————————————————

  /** Renders one block into `out0`/`out1` (overwritten). `time` = context time of frame 0. */
  mixBlock(out0: Float32Array, out1: Float32Array, n: number, time: number): void {
    if (this.a0.length < n) this.grow(n);
    out0.fill(0, 0, n);
    out1.fill(0, 0, n);
    if (this.state === "buffering" && this.isBuffered()) {
      this.setState("playing");
      this.fade = 0;
      const ci = this.pendingCountIn;
      this.pendingCountIn = null;
      if (ci) this.startPreroll(ci);
      this.fadeDir = ci ? 0 : 1; // the audio fades in when the count-in ends
      this.sendReport(time);
    }
    if (this.state === "playing") this.renderPlaying(out0, out1, n);
    const pk = this.voices.render(out0, out1, n);
    if (pk > this.master0) this.master0 = pk;
    if (pk > this.master1) this.master1 = pk;
    this.sinceReport += n;
    if (this.sinceReport >= REPORT_FRAMES) {
      this.sinceReport = 0;
      // The position is the block's end: pair it with the end's context time.
      this.sendReport(time + n / SAMPLE_RATE);
    }
  }

  private renderPlaying(out0: Float32Array, out1: Float32Array, n: number) {
    let o = 0;
    while (o < n) {
      if (this.preroll > 0) {
        const len = Math.min(n - o, this.preroll);
        this.renderPreroll(out0, out1, o, len);
        o += len;
        if (this.preroll === 0) {
          this.preSpec = null;
          this.fade = 0;
          this.fadeDir = 1;
        }
        continue;
      }
      const loop = this.loop;
      // Past the loop end (or without a loop) playback runs to the song end and stops.
      const looping = loop !== null && this.frame < loop.end;
      if (!looping && this.frame >= this.length) {
        this.frame = this.length;
        this.setState("stopped");
        this.fade = 0;
        this.fadeDir = 0;
        this.emit(ENDED);
        break;
      }
      let len = n - o;
      if (looping) len = Math.min(len, loop.end - this.frame);
      else len = Math.min(len, this.length - this.frame);
      // Transport fades end on segment boundaries so the pending action lands exactly.
      if (this.fadeDir < 0) len = Math.min(len, Math.max(1, Math.ceil(this.fade * FADE_FRAMES)));
      this.renderSegment(out0, out1, o, len);
      this.frame += len;
      o += len;
      if (looping && this.frame >= loop.end) {
        this.lap++;
        this.frame = loop.start;
        const ci = this.repeatCountIn;
        if (ci && this.fadeDir >= 0) {
          // Count-in before the repeat (SPEC §6.7): the lap's tail fades out, clicks, fade in.
          this.startPreroll(ci);
          this.tailOut = FADE_FRAMES;
          this.wrapFade = 0;
          this.fade = 0;
          this.fadeDir = 0;
        } else {
          this.wrapFade = FADE_FRAMES;
        }
        for (let i = 0; i < this.tracks.length; i++) {
          const t = this.tracks[i];
          if (t) this.pruneTrack(t, this.lap - 1, loop.end);
        }
      }
      if (this.fadeDir < 0 && this.fade <= 0) {
        this.fade = 0;
        this.fadeDir = 0;
        if (this.pendingSeek) {
          const s = this.pendingSeek;
          this.pendingSeek = null;
          this.jump(s.frame, s.lap);
          if (!this.pendingStop) this.setState("buffering");
        }
        if (this.pendingStop) {
          this.pendingStop = false;
          this.setState("stopped");
        }
        break;
      }
    }
    if (this.state === "playing" || o > 0) {
      for (let i = 0; i < this.tracks.length; i++) {
        const t = this.tracks[i];
        if (t) this.pruneTrack(t, this.lap, this.frame);
      }
    }
  }

  /** Count-in clicks and, after a loop wrap, the fade-out of the lap's tail. */
  private renderPreroll(out0: Float32Array, out1: Float32Array, o: number, len: number) {
    const spec = this.preSpec;
    if (spec) {
      const from = this.prerollDone;
      const to = from + len;
      // Clicks land on rounded frames: k × interval just below `from` can round up into it.
      const k0 = Math.max(0, Math.ceil((from - 0.5) / spec.intervalFrames - 1e-9));
      for (let k = k0; k < spec.clicks; k++) {
        const at = Math.round(k * spec.intervalFrames);
        if (at >= to) break;
        if (at < from) continue;
        this.voices.trigger(
          this.clickSample(k % spec.perBar === 0 ? 0 : 1),
          o + at - from,
          this.clickGain,
        );
      }
    }
    const loop = this.loop;
    const tailN = Math.min(this.tailOut, len);
    if (tailN > 0 && loop) {
      const { a0, a1 } = this;
      const done = FADE_FRAMES - this.tailOut;
      for (let ti = 0; ti < this.tracks.length; ti++) {
        const t = this.tracks[ti];
        if (!t || (t.cur0 === 0 && t.cur1 === 0)) continue;
        a0.fill(0, 0, tailN);
        a1.fill(0, 0, tailN);
        readSplit(t.queue, t.cache, this.lap - 1, loop.end + done, tailN, a0, a1);
        for (let i = 0; i < tailN; i++) {
          const w = Math.cos(((done + i + 0.5) / FADE_FRAMES) * (Math.PI / 2));
          out0[o + i] = (out0[o + i] ?? 0) + (a0[i] ?? 0) * t.cur0 * w;
          out1[o + i] = (out1[o + i] ?? 0) + (a1[i] ?? 0) * t.cur1 * w;
        }
      }
    }
    this.tailOut = Math.max(0, this.tailOut - tailN);
    this.prerollDone += len;
    this.preroll -= len;
  }

  /** Triggers the timeline clicks in `[frame, frame + len)` at block offset `o`. */
  private triggerClicks(o: number, len: number) {
    const frames = this.clickFrames;
    if (frames.length === 0 || !this.clickAudible()) return;
    const end = this.frame + len;
    for (let i = firstAtOrAfter(frames, this.frame); i < frames.length; i++) {
      const f = frames[i] ?? 0;
      if (f >= end) break;
      this.voices.trigger(
        this.clickSample(this.clickLevels[i] ?? 1),
        o + f - this.frame,
        this.clickGain,
      );
    }
  }

  private renderSegment(out0: Float32Array, out1: Float32Array, o: number, len: number) {
    const { a0, a1, b0, b1 } = this;
    const loop = this.loop;
    const wrapN = Math.min(this.wrapFade, len);
    this.triggerClicks(o, len);
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const t = this.tracks[ti];
      if (!t) continue;
      a0.fill(0, 0, len);
      a1.fill(0, 0, len);
      let missing = readSplit(t.queue, t.cache, this.lap, this.frame, len, a0, a1);

      // Version switch: once the new source covers this block, crossfade linearly (same
      // material, time-aligned) and then drop the old one.
      if (
        t.pending >= 0 &&
        t.switchFade === 0 &&
        coversSplit(t.pendingQueue, t.pendingCache, this.lap, this.frame, this.frame + len)
      ) {
        t.switchFade = FADE_FRAMES;
      }
      if (t.switchFade > 0) {
        b0.fill(0, 0, len);
        b1.fill(0, 0, len);
        missing = readSplit(t.pendingQueue, t.pendingCache, this.lap, this.frame, len, b0, b1);
        for (let i = 0; i < len; i++) {
          const w = Math.min(1, (FADE_FRAMES - t.switchFade + i) / FADE_FRAMES);
          a0[i] = (a0[i] ?? 0) * (1 - w) + (b0[i] ?? 0) * w;
          a1[i] = (a1[i] ?? 0) * (1 - w) + (b1[i] ?? 0) * w;
        }
        t.switchFade = Math.max(0, t.switchFade - len);
        if (t.switchFade === 0) this.completeSwitch(t);
      }

      // Loop wrap: equal-power crossfade from the previous lap's tail (decoded past the loop end).
      if (wrapN > 0 && loop) {
        b0.fill(0, 0, wrapN);
        b1.fill(0, 0, wrapN);
        const done = FADE_FRAMES - this.wrapFade;
        readSplit(t.queue, t.cache, this.lap - 1, loop.end + done, wrapN, b0, b1);
        for (let i = 0; i < wrapN; i++) {
          const x = ((done + i + 0.5) / FADE_FRAMES) * (Math.PI / 2);
          const wi = Math.sin(x);
          const wo = Math.cos(x);
          a0[i] = (a0[i] ?? 0) * wi + (b0[i] ?? 0) * wo;
          a1[i] = (a1[i] ?? 0) * wi + (b1[i] ?? 0) * wo;
        }
      }

      const audible = t.target0 > 0 || t.target1 > 0 || t.cur0 > 0 || t.cur1 > 0;
      if (audible && missing > 0 && !t.failed) {
        const outside = len - inClips(t.clips, this.frame, this.frame + len);
        const under = missing - outside;
        if (under > 0 && (t.target0 > 0 || t.target1 > 0)) t.underrun += under;
      }
      if (!audible) continue;

      let peak = t.peak;
      let fade = this.fade;
      for (let i = 0; i < len; i++) {
        if (t.rampLeft > 0) {
          t.cur0 += t.step0;
          t.cur1 += t.step1;
          if (--t.rampLeft === 0) {
            t.cur0 = t.target0;
            t.cur1 = t.target1;
          }
        }
        if (this.fadeDir !== 0) {
          fade += this.fadeDir / FADE_FRAMES;
          fade = fade < 0 ? 0 : fade > 1 ? 1 : fade;
        }
        const s0 = (a0[i] ?? 0) * t.cur0 * fade;
        const s1 = (a1[i] ?? 0) * t.cur1 * fade;
        out0[o + i] = (out0[o + i] ?? 0) + s0;
        out1[o + i] = (out1[o + i] ?? 0) + s1;
        const m = s0 > 0 ? s0 : -s0;
        if (m > peak) peak = m;
        const m1 = s1 > 0 ? s1 : -s1;
        if (m1 > peak) peak = m1;
      }
      t.peak = peak;
    }
    // Advance the transport fade once per segment (tracks computed it identically).
    if (this.fadeDir !== 0) {
      this.fade = Math.min(1, Math.max(0, this.fade + (this.fadeDir * len) / FADE_FRAMES));
      if (this.fadeDir > 0 && this.fade >= 1) this.fadeDir = 0;
    }
    this.wrapFade = Math.max(0, this.wrapFade - wrapN);
    for (let i = o; i < o + len; i++) {
      const m0 = Math.abs(out0[i] ?? 0);
      const m1 = Math.abs(out1[i] ?? 0);
      if (m0 > this.master0) this.master0 = m0;
      if (m1 > this.master1) this.master1 = m1;
    }
  }

  private completeSwitch(t: Track) {
    swapPending(t, this.cacheRegion());
    this.updateTargets(false);
  }

  private pruneTrack(t: Track, lap: number, frame: number) {
    // Keep the previous lap's tail while a wrap crossfade (or a count-in fade-out) reads it.
    pruneTrack(t, lap, frame, Math.max(this.wrapFade, this.tailOut), this.loop);
  }

  private jump(frame: number, lap: number) {
    this.frame = frame;
    this.lap = lap;
    this.wrapFade = 0;
    this.preroll = 0;
    this.preSpec = null;
    this.tailOut = 0;
    for (let i = 0; i < this.tracks.length; i++) {
      const t = this.tracks[i];
      if (!t) continue;
      // After a jump the decoder only delivers the newest source.
      if (t.pending >= 0) this.completeSwitch(t);
      t.queue.prune(lap, frame);
    }
  }

  /**
   * Every audible track (except failed ones) has `startFrames` of data ahead, in playback order
   * across a wrap.
   */
  private isBuffered(): boolean {
    const want = Math.min(this.startFrames, this.remainingFrames());
    if (want <= 0) return true;
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const t = this.tracks[ti];
      if (!t || (t.target0 === 0 && t.target1 === 0) || t.failed) continue;
      let lap = this.lap;
      let from = this.frame;
      let left = want;
      while (left > 0) {
        let to = from + left;
        const loop = this.loop;
        const wraps = loop !== null && from < loop.end && to > loop.end;
        if (wraps) to = loop.end;
        for (let ci = 0; ci < t.clips.length; ci++) {
          const c = t.clips[ci];
          if (!c) continue;
          const a = Math.max(from, c.start);
          const b = Math.min(to, c.end);
          if (b > a && !coversSplit(t.queue, t.cache, lap, a, b)) return false;
        }
        left -= to - from;
        if (!wraps) break;
        lap++;
        from = loop.start;
      }
    }
    return true;
  }

  private remainingFrames(): number {
    return this.loop && this.frame < this.loop.end ? Infinity : this.length - this.frame;
  }

  private updateTargets(immediate: boolean) {
    this.anyTrackSolo = updateTargets(this.tracks, this.click.solo, this.panOut, immediate);
  }

  private setState(s: TransportState) {
    if (s === this.state) return;
    this.state = s;
    this.emit(STATE_EVENTS[s]);
  }

  /** Fills the preallocated report (position, meters, underruns) and emits it. */
  private sendReport(time: number) {
    const r = this.report;
    r.frame = this.frame;
    r.lap = this.lap;
    r.time = time;
    r.playing = this.state === "playing";
    r.preroll = this.preroll;
    r.prerollInterval = this.preSpec?.intervalFrames ?? 0;
    r.prerollClicks = this.preSpec?.clicks ?? 0;
    r.clicks = this.voices.count;
    const n = this.tracks.length;
    for (let i = 0; i < n; i++) {
      const t = this.tracks[i];
      if (!t) continue;
      r.peaks[i] = t.peak;
      t.peak = 0;
      r.underruns[i] = t.underrun;
      t.underrun = 0;
    }
    r.peaks[n] = this.master0;
    r.peaks[n + 1] = this.master1;
    this.master0 = 0;
    this.master1 = 0;
    this.emit(r);
  }

  private grow(n: number) {
    this.a0 = new Float32Array(n);
    this.a1 = new Float32Array(n);
    this.b0 = new Float32Array(n);
    this.b1 = new Float32Array(n);
  }
}
