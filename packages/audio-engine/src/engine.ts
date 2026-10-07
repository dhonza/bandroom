import { SAMPLE_RATE } from "./constants";
import { Emitter } from "./emitter";
import type {
  CountInState,
  EngineEvents,
  EngineOptions,
  EngineState,
  TrackState,
} from "./engineTypes";
import type { ClickTrack, CountInSpec } from "./mixer/click";
import { loopCacheFits } from "./mixer/loopCache";
import {
  DEFAULT_CLICK,
  FADE_FRAMES,
  LAPS_PER_SEEK,
  type ClickParams,
  type ClipRange,
  type MixerReport,
  type MixerTrackConfig,
  type TrackParams,
} from "./mixer/core";
import type { MixerCommand, MixerMessage } from "./mixer/protocol";
import { countInAt, NO_REPORT, playheadAt, type Report } from "./playhead";
import {
  clipRanges,
  type EngineClip,
  type SongTimeline,
  type WorkerCommand,
  type WorkerEvent,
} from "./types";

export * from "./engineTypes";

/** Shortest loop (SPEC §7.6: 250 ms). */
export const MIN_LOOP_FRAMES = 12_000;

/** How long `play()` waits for the AudioContext to run before reporting an interruption. */
const RESUME_TIMEOUT_MS = 3000;
const IDLE_SUSPEND_MS = 30_000;
/** Silent meter reports still sent (1 s at 20 Hz: meters fall back to zero). */
const SILENT_METER_REPORTS = 20;
/** Mixer settings that survive a load (the rest of the queue belongs to the superseded song). */
const KEPT_ACROSS_LOADS: ReadonlySet<MixerCommand["t"]> = new Set([
  "startFrames",
  "click",
  "clickTrack",
  "repeatCountIn",
]);

/**
 * Rehearse-mode engine (SPEC §6.3): an AudioContext at 48 kHz, the mixer worklet and the decoder
 * worker. Framework-agnostic; the web app drives it through a store.
 */
export class Engine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private events = new Emitter<EngineEvents>();
  private _state: EngineState = "idle";
  private trackIds: string[] = [];
  private sources: number[] = [];
  private length = 0;
  private loop: ClipRange | null = null;
  private cacheOn = false;
  private seekCount = 0;
  private report: Report = NO_REPORT;
  private click: ClickParams = { ...DEFAULT_CLICK };
  private lastCountIn: CountInSpec | null = null;
  private repeatCountIn: CountInSpec | null = null;
  /** Position shown until the first report after a seek arrives. */
  private seekTarget: number | null = null;
  private wantPlaying = false;
  private loadSeq = 0;
  /**
   * The load in flight. It reaches the mixer through the decoder worker, while other commands go
   * straight to the mixer's port; the two ports are not ordered, so mixer commands wait in
   * `queued` until the mixer acknowledges this load.
   */
  private pending: { id: number; settle: (done: boolean) => void } | null = null;
  private queued: MixerCommand[] = [];
  private underruns = 0;
  /** The loaded song with the mix and sources applied since (what `rebuild` restores). */
  private song: SongTimeline | null = null;
  private offsets: number[] = [];
  private clickTrack: ClickTrack | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  /** A resume did not bring the context back (Safari): the next `play()` rebuilds it. */
  private stale = false;
  /** A rebuild is restoring the song: mixer state and position reports are not shown yet. */
  private restoring = false;
  /**
   * Set by `suspend()`: the context stops before the worklet renders the pause, so the mixer's
   * "stopped" report may never come; the engine reports it itself and ignores stale "playing"
   * reports until the next `play()`.
   */
  private handedOff = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Silent meter reports in a row (after a second of them, no more are sent). */
  private silentReports = 0;

  constructor(private readonly opts: EngineOptions) {}

  get state(): EngineState {
    return this._state;
  }

  get lengthFrames(): number {
    return this.length;
  }

  get underrunCount(): number {
    return this.underruns;
  }

  /** The AudioContext's state (`running`, `suspended`, Safari's `interrupted`; debug state). */
  get contextState(): string {
    return this.ctx?.state ?? "none";
  }

  /**
   * Creates the AudioContext. Must be called from a user gesture handler (iOS unlock, SPEC §6.8):
   * the context is created and resumed synchronously, the rest is awaited.
   */
  init(): Promise<void> {
    if (this.ready) {
      void this.ctx?.resume();
      return this.ready;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "playback" });
    } catch (err) {
      this.setState("error");
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    this.ctx = ctx;
    void ctx.resume();
    ctx.onstatechange = () => {
      this.onContextState();
    };
    const ready = this.setup(ctx).catch((err: unknown) => {
      // Not permanent: drop the half-built context so the next init() (a tap) starts over.
      if (this.ready === ready) {
        this.teardown();
        this.setState("error");
      }
      throw err;
    });
    this.ready = ready;
    return ready;
  }

  private async setup(ctx: AudioContext) {
    if (ctx.sampleRate !== SAMPLE_RATE)
      throw new Error(`AudioContext runs at ${ctx.sampleRate} Hz`);
    await ctx.audioWorklet.addModule(this.opts.workletUrl);
    const node = new AudioWorkletNode(ctx, "bandroom-mixer", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent<MixerMessage>) => {
      this.onMixer(e.data);
    };
    const worker = new Worker(this.opts.workerUrl, { type: "module" });
    worker.onmessage = (e: MessageEvent<WorkerEvent>) => {
      this.onWorker(e.data);
    };
    const channel = new MessageChannel();
    this.toWorker(
      {
        t: "init",
        port: channel.port1,
        cacheBytes: this.opts.cacheBytes,
        windowFrames: Math.round((this.opts.windowSeconds ?? 4) * SAMPLE_RATE),
      },
      worker,
      [channel.port1],
    );
    node.port.postMessage({ t: "workerPort", port: channel.port2 } satisfies MixerCommand, [
      channel.port2,
    ]);
    this.node = node;
    this.worker = worker;
    this.toMixer({
      t: "startFrames",
      frames: Math.round((this.opts.startSeconds ?? 1.5) * SAMPLE_RATE),
    });
  }

  /**
   * Loads a song. Resolves `true` once the mixer has it, or `false` when another load or
   * `dispose()` superseded it (the caller then leaves the engine alone).
   */
  async loadSong(song: SongTimeline): Promise<boolean> {
    await this.init();
    this.wantPlaying = false;
    this.restoring = false; // a new song supersedes a rebuild in progress
    this.setState("loading");
    if (!(await this.load(song))) return false;
    this.setState("stopped");
    return true;
  }

  private load(song: SongTimeline): Promise<boolean> {
    this.song = {
      lengthFrames: song.lengthFrames,
      tracks: song.tracks.map((t) => ({ ...t, clips: [...t.clips] })),
    };
    this.offsets = song.tracks.map(() => 0);
    this.trackIds = song.tracks.map((t) => t.id);
    this.sources = song.tracks.map(() => 1);
    this.length = song.lengthFrames;
    this.loop = null;
    this.cacheOn = false;
    this.report = NO_REPORT;
    this.seekTarget = null;
    this.seekCount = 0;
    this.underruns = 0;
    const mixer: MixerTrackConfig[] = song.tracks.map((t) => ({
      id: t.id,
      source: 1,
      channels: t.clips[0]?.variant.channels ?? 2,
      dualMono: t.clips[0]?.variant.dualMono ?? false,
      clips: clipRanges(t.clips),
      gainDb: t.gainDb,
      pan: t.pan,
      mute: t.mute,
      solo: t.solo,
      trimDb: t.trimDb ?? 0,
    }));
    this.settleLoad(false);
    this.queued = this.queued.filter((c) => KEPT_ACROSS_LOADS.has(c.t));
    const id = ++this.loadSeq;
    const done = new Promise<boolean>((resolve) => {
      this.pending = { id, settle: resolve };
    });
    this.toWorker({
      t: "load",
      id,
      tracks: song.tracks.map((t, index) => ({ index, source: 1, clips: t.clips })),
      lengthFrames: song.lengthFrames,
      mixer,
    });
    return done;
  }

  private settleLoad(done: boolean) {
    const p = this.pending;
    this.pending = null;
    p?.settle(done);
  }

  /**
   * Starts playback (call from a gesture the first time; resumes a suspended context). With
   * `countIn`, the count-in clicks play before the timeline audio (SPEC §6.7).
   */
  play(opts: { countIn?: CountInSpec | null } = {}): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.handedOff = false;
    const countIn = opts.countIn ?? null;
    if (countIn) this.lastCountIn = countIn;
    // Safari can leave the context interrupted after another player took the audio (Listen
    // mode's <audio>); resume() then never completes.
    const st = ctx.state as string;
    if (this.song && !this.restoring && (this.stale || st === "interrupted" || st === "closed")) {
      this.rebuild(countIn);
      return;
    }
    void ctx.resume();
    this.wantPlaying = true;
    if (this._state === "interrupted") this.setState("buffering");
    this.toMixer({ t: "play", countIn });
    this.watchResume();
  }

  /** A context that does not run shortly after `play()` is reported as an interruption. */
  private watchResume() {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (!this.wantPlaying || this.ctx?.state === "running") return;
      this.stale = true;
      this.wantPlaying = false;
      this.toMixer({ t: "pause" });
      this.setState("interrupted");
    }, RESUME_TIMEOUT_MS);
  }

  /**
   * Replaces a context that no longer resumes with a fresh one (created inside the tap) and
   * restores the song, mix, sources, click, loop and position, then plays.
   */
  private rebuild(countIn: CountInSpec | null) {
    const song = this.song;
    if (!song) return;
    const at = this.getPositionFrames();
    const loop = this.loop;
    const offsets = [...this.offsets];
    this.teardown();
    this.stale = false;
    this.restoring = true;
    this.wantPlaying = true;
    this.setState("buffering");
    this.seekTarget = at;
    const restore = async () => {
      await this.init();
      const loading = this.load(song);
      const restored = this.song;
      this.seekTarget = at; // load() resets it; keep showing the position meanwhile
      // Superseded by another song (or disposed) meanwhile: that load owns the engine now.
      if (!(await loading) || this.song !== restored) return;
      offsets.forEach((offsetDb, index) => {
        if (offsetDb !== 0) this.toMixer({ t: "track", index, params: { offsetDb } });
      });
      this.setClick(this.click);
      this.setClickTrack(this.clickTrack);
      this.setRepeatCountIn(this.repeatCountIn);
      if (at > 0) this.seek(at);
      this.setLoop(loop);
      this.restoring = false;
      if (!this.wantPlaying) {
        this.setState("stopped");
        return;
      }
      this.toMixer({ t: "play", countIn });
      this.watchResume();
    };
    restore().catch(() => {
      this.restoring = false;
      this.wantPlaying = false;
      // A context that failed to start reports "error" (retried by the next init()).
      if (this._state !== "error") this.setState("interrupted");
    });
  }

  /** The song's click pulses (SPEC §6.7), precomputed from the tempo map; null clears them. */
  setClickTrack(track: ClickTrack | null): void {
    this.clickTrack = track;
    this.toMixer({
      t: "clickTrack",
      frames: track?.frames ?? new Float64Array(0),
      levels: track?.levels ?? new Uint8Array(0),
    });
  }

  /** Click on/off, volume, accent, sound, solo and "solo excludes click" (SPEC §6.6, §6.7). */
  setClick(p: Partial<ClickParams>): void {
    this.click = { ...this.click, ...p };
    this.toMixer({ t: "click", params: p });
  }

  get clickParams(): ClickParams {
    return this.click;
  }

  /** "Count-in every repeat": the count-in inserted at each loop wrap, or null (SPEC §6.7). */
  setRepeatCountIn(countIn: CountInSpec | null): void {
    this.repeatCountIn = countIn;
    this.toMixer({ t: "repeatCountIn", countIn });
  }

  /** The count-in inserted at every loop wrap (debug state). */
  get repeatCountInSpec(): CountInSpec | null {
    return this.repeatCountIn;
  }

  /** The count-in last requested (debug state). */
  get lastCountInSpec(): CountInSpec | null {
    return this.lastCountIn;
  }

  /** Clicks triggered by the mixer since the song was loaded (debug state). */
  get clickCount(): number {
    return this.report.clicks;
  }

  /** The count-in being played, interpolated like the position; null when none. */
  getCountIn(): CountInState | null {
    const r = this.report;
    if (r.preroll <= 0 || r.prerollInterval <= 0 || this._state !== "playing") return null;
    return countInAt(r, this.heardSince(r) * SAMPLE_RATE);
  }

  /** Seconds heard since a report (output latency compensated). */
  private heardSince(r: Report): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    // getOutputTimestamp is missing in some older engines.
    const ts = (ctx as { getOutputTimestamp?: () => AudioTimestamp }).getOutputTimestamp;
    const heard =
      ts?.call(ctx).contextTime ?? ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    return Math.max(0, heard - r.time);
  }

  pause(): void {
    this.wantPlaying = false;
    this.toMixer({ t: "pause" });
  }

  seek(frame: number): void {
    const f = Math.max(0, Math.min(Math.round(frame), this.length));
    this.seekCount++;
    const lap = this.seekCount * LAPS_PER_SEEK;
    this.seekTarget = f;
    // The mixer forwards the seek to the decoder worker (ordered with loop changes).
    this.toMixer({ t: "seek", frame: f, lap });
  }

  /**
   * Loop range in frames (sample-accurate wrap, SPEC §6.6), or null. Applied while playing
   * without a rebuffer; loops shorter than 250 ms (SPEC §7.6) are ignored. With the loop region
   * within the 64 MB budget, repeats play from the mixer's loop cache (SPEC §6.4).
   */
  setLoop(range: ClipRange | null): void {
    const start = range ? Math.max(0, Math.round(range.start)) : 0;
    const end = range ? Math.min(this.length, Math.round(range.end)) : 0;
    const loop = range && end - start >= MIN_LOOP_FRAMES ? { start, end } : null;
    if (loop === null && this.loop === null) return;
    this.loop = loop;
    this.cacheOn = loop !== null && loopCacheFits(loop, this.trackIds.length, FADE_FRAMES);
    this.seekCount++;
    this.toMixer({
      t: "loop",
      loop,
      base: this.seekCount * LAPS_PER_SEEK,
      cache: this.cacheOn,
    });
  }

  get loopRange(): ClipRange | null {
    return this.loop;
  }

  /** The current loop is served from the loop cache (debug state). */
  get loopCached(): boolean {
    return this.cacheOn;
  }

  /** Loop repeats since the loop was set or the last seek (debug state for e2e). */
  get lapInBase(): number {
    return this.report.lap % LAPS_PER_SEEK;
  }

  /** Mixer state, the A/B loudness offset and the playing version's gain (`trimDb`). */
  setTrackState(
    trackId: string,
    s: Partial<TrackState & { offsetDb: number; trimDb: number }>,
  ): void {
    const index = this.trackIds.indexOf(trackId);
    if (index < 0) return;
    const params: Partial<TrackParams> = s;
    const t = this.song?.tracks[index];
    if (t) {
      if (s.gainDb !== undefined) t.gainDb = s.gainDb;
      if (s.pan !== undefined) t.pan = s.pan;
      if (s.mute !== undefined) t.mute = s.mute;
      if (s.solo !== undefined) t.solo = s.solo;
      if (s.trimDb !== undefined) t.trimDb = s.trimDb;
    }
    if (s.offsetDb !== undefined) this.offsets[index] = s.offsetDb;
    this.toMixer({ t: "track", index, params });
  }

  /**
   * Replaces a track's clips (version A/B or quality switch, SPEC §6.5/§6.9): seamless while
   * playing, keeping the timeline position. `trimDb` is the new version's gain (SPEC §25.6); it
   * takes effect with the new source (default: the track's current one).
   */
  switchSource(trackId: string, clips: EngineClip[], offsetDb = 0, trimDb?: number): void {
    const index = this.trackIds.indexOf(trackId);
    if (index < 0) return;
    const source = (this.sources[index] ?? 1) + 1;
    this.sources[index] = source;
    const t = this.song?.tracks[index];
    const trim = trimDb ?? t?.trimDb ?? 0;
    if (t) {
      t.clips = [...clips];
      t.trimDb = trim;
    }
    this.offsets[index] = offsetDb;
    this.toWorker({ t: "source", index, source, clips, offsetDb, trimDb: trim });
  }

  /** Interpolated position of what is being heard, in frames (SPEC §6.6). */
  getPositionFrames(): number {
    if (this.seekTarget !== null) return this.seekTarget;
    const ctx = this.ctx;
    const r = this.report;
    if (!ctx || this._state !== "playing") return r.frame;
    const elapsed = this.heardSince(r) * SAMPLE_RATE;
    return playheadAt(r, elapsed, this.loop, this.repeatCountIn, this.length);
  }

  on<K extends keyof EngineEvents>(event: K, cb: (e: EngineEvents[K]) => void): () => void {
    return this.events.on(event, cb);
  }

  dispose(): void {
    this.wantPlaying = false;
    this.toWorker({ t: "unload" });
    this.teardown();
    this.song = null;
    this.setState("idle");
  }

  private teardown() {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.cancelIdle();
    this.worker?.terminate();
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    if (this.ctx) {
      this.ctx.onstatechange = null;
      void this.ctx.close();
    }
    this.ctx = null;
    this.node = null;
    this.worker = null;
    this.ready = null;
    this.queued = [];
    this.settleLoad(false);
  }

  /**
   * Stops audio for another player (Listen mode) without tearing the engine down: the context is
   * suspended so the worklet stops rendering; the next `play()` resumes it inside the tap.
   */
  suspend(): void {
    this.pause();
    this.handedOff = true;
    if (this._state === "playing" || this._state === "buffering") this.setState("stopped");
    this.cancelIdle();
    void this.ctx?.suspend();
  }

  /**
   * After a while stopped, the context is suspended: the worklet stops running (battery) and no
   * meters or positions are sent. `play()` resumes it synchronously inside the tap (iOS), and a
   * context that does not come back is rebuilt (`stale`, as after Listen mode).
   */
  private scheduleIdle() {
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const st = this._state;
      if (this.wantPlaying || this.restoring) return;
      if (st !== "stopped" && st !== "interrupted") return;
      if (this.ctx?.state === "running") void this.ctx.suspend();
    }, this.opts.idleSuspendMs ?? IDLE_SUSPEND_MS);
  }

  private cancelIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private emit<K extends keyof EngineEvents>(event: K, payload: EngineEvents[K]) {
    this.events.emit(event, payload);
  }

  private setState(s: EngineState) {
    if (s === this._state) return;
    this._state = s;
    if (s === "stopped" || s === "interrupted") this.scheduleIdle();
    else this.cancelIdle();
    this.emit("state", s);
  }

  /** Interruption (phone call, other app): pause and wait for a tap (SPEC §6.8). */
  private onContextState() {
    const st = this.ctx?.state as string | undefined;
    if ((st === "interrupted" || st === "suspended") && this.wantPlaying) {
      this.wantPlaying = false;
      this.toMixer({ t: "pause" });
      this.setState("interrupted");
    }
  }

  private onMixer(m: MixerMessage) {
    switch (m.type) {
      case "loaded": {
        if (this.pending?.id !== m.id) break; // a superseded load
        const q = this.queued;
        this.queued = [];
        const p = this.pending;
        this.pending = null;
        for (const cmd of q) this.toMixer(cmd);
        p.settle(true);
        break;
      }
      case "state":
        if (this._state === "loading" || this.restoring) break;
        if (this._state === "interrupted" && m.state !== "playing") break;
        if (this.handedOff && m.state !== "stopped") break;
        this.setState(m.state);
        break;
      case "report": {
        this.onReport(m);
        m.underruns.forEach((frames, i) => {
          if (frames <= 0) return;
          this.underruns += frames;
          this.emit("underrun", { trackId: this.trackIds[i] ?? "", frames });
        });
        // While nothing sounds, meters stop after their fall-off (no 20 Hz DOM updates).
        this.silentReports = m.peaks.every((p) => p === 0) ? this.silentReports + 1 : 0;
        if (this.silentReports > SILENT_METER_REPORTS) break;
        const tracks: Record<string, number> = {};
        this.trackIds.forEach((id, i) => (tracks[id] = m.peaks[i] ?? 0));
        const n = this.trackIds.length;
        this.emit("meters", { tracks, master: [m.peaks[n] ?? 0, m.peaks[n + 1] ?? 0] });
        break;
      }
      case "ended":
        this.wantPlaying = false;
        this.emit("ended", undefined);
        break;
    }
  }

  private onReport(m: MixerReport) {
    if (this.restoring) return;
    if (this.seekTarget !== null && m.lap < this.seekCount * LAPS_PER_SEEK) return;
    this.seekTarget = null;
    this.report = {
      frame: m.frame,
      lap: m.lap,
      time: m.time,
      preroll: m.preroll,
      prerollInterval: m.prerollInterval,
      prerollClicks: m.prerollClicks,
      clicks: m.clicks,
    };
  }

  private onWorker(m: WorkerEvent) {
    if (m.t === "buffer") {
      const out: Record<string, number> = {};
      this.trackIds.forEach((id, i) => (out[id] = (m.ahead[i] ?? 0) / SAMPLE_RATE));
      this.emit("buffer", out);
    } else {
      this.emit("error", { trackId: this.trackIds[m.index] ?? "", message: m.message });
    }
  }

  private toMixer(cmd: MixerCommand) {
    if (this.pending) this.queued.push(cmd);
    else this.node?.port.postMessage(cmd);
  }

  private toWorker(cmd: WorkerCommand, worker = this.worker, transfer: Transferable[] = []) {
    worker?.postMessage(cmd, transfer);
  }
}
