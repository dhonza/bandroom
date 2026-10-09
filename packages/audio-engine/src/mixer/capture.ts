import { SAMPLE_RATE } from "../constants";

/**
 * Recording capture (SPEC §9): the mixer worklet copies its input (the microphone, connected only
 * while armed) into pooled chunks and posts them over the take port to the take writer. It runs
 * in the render loop, so it never allocates: the buffers come from the main thread and come back
 * from the consumer (`TakeFree`), and the messages are preallocated objects that `postMessage`
 * clones.
 */

/** Frames per take chunk (per channel; the data is interleaved). */
export const CAPTURE_CHUNK_FRAMES = 4096;
/** Most buffers the pool holds. */
const POOL_MAX = 256;

/** Why a take ended. */
export type TakeEndReason =
  /** Stop pressed. */
  | "user"
  /** The maximum take length was reached. */
  | "maxLength"
  /** The audio context was interrupted (phone call, another app). */
  | "interrupted"
  /** The audio context was replaced (Safari after an interruption). */
  | "rebuilt"
  /** The input device went away (unplugged, permission revoked). */
  | "inputEnded"
  /** The page was hidden (app switch, screen lock). */
  | "hidden"
  /** The transport stopped or jumped by itself (pause from media keys, a seek). */
  | "transport"
  /** The song was reloaded in the engine. */
  | "reloaded"
  /** The input was disconnected while recording. */
  | "disarmed"
  /** The engine was disposed. */
  | "disposed";

/** Worklet → take writer: a take begins at `startFrame` (timeline frame, 48 kHz). */
export interface TakeStart {
  type: "take.start";
  startFrame: number;
  channels: number;
  sampleRate: number;
}

/**
 * Worklet → take writer: `frames` frames of interleaved samples (`data[i * channels + c]`) in a
 * pooled buffer (transferred). Return it with {@link TakeFree} once written.
 */
export interface TakeChunk {
  type: "take.chunk";
  seq: number;
  frames: number;
  channels: number;
  data: Float32Array;
}

/**
 * Worklet → take writer: `frames` frames were lost here (no free buffer); write silence so the
 * rest of the take keeps its timing.
 */
export interface TakeGap {
  type: "take.gap";
  frames: number;
}

/**
 * Worklet → take writer and main thread: the take ended; `frames` counts every frame of the take
 * (gaps included), so the file must hold exactly that many.
 */
export interface TakeEnd {
  type: "take.end";
  startFrame: number;
  frames: number;
  channels: number;
  gapFrames: number;
  endedBy: TakeEndReason;
}

export type TakeMessage = TakeStart | TakeChunk | TakeGap | TakeEnd;

/** Take writer → worklet (on the take port): a chunk buffer back to the pool (transferred). */
export interface TakeFree {
  t: "free";
  data: Float32Array;
}

const NO_DATA = new Float32Array(0);

/** The capture state of the mixer: armed (input metered), requested, recording. */
export class Capture {
  armed = false;
  channels = 1;
  maxFrames = Number.POSITIVE_INFINITY;
  /** A take was requested: it begins where the count-in ends (or at the next block). */
  wanted = false;
  /** A take is being recorded. */
  on = false;
  startFrame = 0;
  /** Frames of the take so far (gaps included). */
  frames = 0;
  gapFrames = 0;
  /** Input peak per channel since the last report. */
  peak0 = 0;
  peak1 = 0;
  /**
   * Input gain (linear): `gain` at the end of the last block, ramping to `gainTarget` across the
   * next one (no zipper noise); `rampFrom`/`rampStep` describe the current block's ramp.
   */
  private gain = 1;
  private gainTarget = 1;
  private rampFrom = 1;
  private rampStep = 0;
  private pendingGap = 0;
  private seq = 0;
  private pool: (Float32Array | null)[] = new Array<Float32Array | null>(POOL_MAX).fill(null);
  private poolN = 0;
  private buf: Float32Array | null = null;
  private fill = 0;
  private readonly startMsg: TakeStart = {
    type: "take.start",
    startFrame: 0,
    channels: 1,
    sampleRate: SAMPLE_RATE,
  };
  private readonly chunkMsg: TakeChunk = {
    type: "take.chunk",
    seq: 0,
    frames: 0,
    channels: 1,
    data: NO_DATA,
  };
  private readonly gapMsg: TakeGap = { type: "take.gap", frames: 0 };
  private readonly endMsg: TakeEnd = {
    type: "take.end",
    startFrame: 0,
    frames: 0,
    channels: 1,
    gapFrames: 0,
    endedBy: "user",
  };

  constructor(private readonly emit: (m: TakeMessage) => void) {}

  /**
   * The input is connected: meter it, and record `channels` (1 or 2) when asked, with the input
   * gain `gainDb` (from the start, no ramp).
   */
  arm(channels: number, maxFrames: number, gainDb = 0): void {
    if (this.on || this.wanted) this.end("disarmed");
    this.armed = true;
    this.channels = channels === 2 ? 2 : 1;
    this.maxFrames = maxFrames > 0 ? maxFrames : Number.POSITIVE_INFINITY;
    this.setGain(gainDb);
    this.gain = this.gainTarget;
    this.rampFrom = this.gain;
    this.rampStep = 0;
  }

  /**
   * Input gain in dB (digital, before metering and writing): the gain ramps to it across the
   * next block. No clipping here: the FLAC encoder clips, a float take keeps the overs.
   */
  setGain(db: number): void {
    this.gainTarget = Number.isFinite(db) ? (db === 0 ? 1 : Math.pow(10, db / 20)) : 1;
  }

  /** The current linear input gain (tests). */
  get linearGain(): number {
    return this.gain;
  }

  disarm(): void {
    this.end("disarmed");
    this.armed = false;
    this.pool.fill(null);
    this.poolN = 0;
    this.peak0 = 0;
    this.peak1 = 0;
  }

  /** A buffer for the pool (from the main thread at arming, then back from the writer). */
  addBuffer(data: Float32Array): void {
    if (data.length < CAPTURE_CHUNK_FRAMES * this.channels || this.poolN >= POOL_MAX) return;
    this.pool[this.poolN++] = data;
  }

  get poolSize(): number {
    return this.poolN;
  }

  /** Starts a take where the count-in ends (see {@link begin}). */
  request(): void {
    if (this.armed && !this.on) this.wanted = true;
  }

  /** The take begins at timeline frame `frame` (block-accurate start found by the mixer). */
  begin(frame: number): void {
    this.wanted = false;
    this.on = true;
    this.startFrame = frame;
    this.frames = 0;
    this.gapFrames = 0;
    this.pendingGap = 0;
    this.seq = 0;
    this.fill = 0;
    const m = this.startMsg;
    m.startFrame = frame;
    m.channels = this.channels;
    this.emit(m);
  }

  /**
   * Input peaks of a block (while armed, also before and after a take), after the input gain.
   * Called once per block before {@link write}: it sets the block's gain ramp.
   */
  meter(input: readonly Float32Array[] | undefined, n: number): void {
    const g0 = this.gain;
    const step = n > 0 ? (this.gainTarget - g0) / n : 0;
    this.rampFrom = g0;
    this.rampStep = step;
    this.gain = this.gainTarget;
    if (!this.armed || !input) return;
    const a = input[0];
    const b = input[1] ?? a;
    if (!a || !b) return;
    let p0 = this.peak0;
    let p1 = this.peak1;
    for (let i = 0; i < n; i++) {
      // Sample i of the ramp; without a ramp exactly `g0` (1 at 0 dB: bit-identical).
      const g = step === 0 ? g0 : g0 + step * (i + 1);
      const x = (a[i] ?? 0) * g;
      const y = (b[i] ?? 0) * g;
      const mx = x > 0 ? x : -x;
      const my = y > 0 ? y : -y;
      if (mx > p0) p0 = mx;
      if (my > p1) p1 = my;
    }
    this.peak0 = p0;
    this.peak1 = p1;
  }

  /** Copies input frames `[from, n)` of the block into the take. */
  write(input: readonly Float32Array[] | undefined, from: number, n: number): void {
    const a = input?.[0];
    const b = input?.[1];
    const ch = this.channels;
    let i = from;
    while (i < n && this.on) {
      const room = this.maxFrames - this.frames;
      if (room <= 0) break;
      if (!this.buf) {
        this.buf = this.take();
        this.fill = 0;
        if (!this.buf) {
          // No free buffer: the frames are lost, the writer fills them with silence.
          const k = Math.min(n - i, room);
          this.pendingGap += k;
          this.gapFrames += k;
          this.frames += k;
          i += k;
          continue;
        }
        this.flushGap();
      }
      const buf = this.buf;
      const k = Math.min(n - i, CAPTURE_CHUNK_FRAMES - this.fill, room);
      let w = this.fill * ch;
      const g0 = this.rampFrom;
      const step = this.rampStep;
      if (ch === 1) {
        for (let j = i; j < i + k; j++) {
          const g = step === 0 ? g0 : g0 + step * (j + 1);
          const x = a ? (a[j] ?? 0) : 0;
          buf[w++] = (b ? (x + (b[j] ?? 0)) * 0.5 : x) * g;
        }
      } else {
        for (let j = i; j < i + k; j++) {
          const g = step === 0 ? g0 : g0 + step * (j + 1);
          const x = a ? (a[j] ?? 0) : 0;
          buf[w++] = x * g;
          buf[w++] = (b ? (b[j] ?? 0) : x) * g;
        }
      }
      this.fill += k;
      this.frames += k;
      i += k;
      if (this.fill >= CAPTURE_CHUNK_FRAMES) this.post();
    }
    if (this.on && this.frames >= this.maxFrames) this.end("maxLength");
  }

  /** Ends the take (a pending request too): the last partial chunk, a gap, then the end. */
  end(reason: TakeEndReason): void {
    if (!this.on && !this.wanted) return;
    const was = this.on;
    this.wanted = false;
    this.on = false;
    if (this.buf && this.fill > 0) this.post();
    this.flushGap();
    const m = this.endMsg;
    m.startFrame = was ? this.startFrame : -1;
    m.frames = was ? this.frames : 0;
    m.channels = this.channels;
    m.gapFrames = was ? this.gapFrames : 0;
    m.endedBy = reason;
    this.emit(m);
  }

  private take(): Float32Array | null {
    if (this.poolN === 0) return null;
    const b = this.pool[--this.poolN] ?? null;
    this.pool[this.poolN] = null;
    return b;
  }

  private post() {
    const m = this.chunkMsg;
    m.seq = this.seq++;
    m.frames = this.fill;
    m.channels = this.channels;
    m.data = this.buf ?? NO_DATA;
    // The buffer is transferred with the message: the mixer lets go of it.
    this.buf = null;
    this.fill = 0;
    this.emit(m);
    m.data = NO_DATA;
  }

  private flushGap() {
    if (this.pendingGap <= 0) return;
    this.gapMsg.frames = this.pendingGap;
    this.pendingGap = 0;
    this.emit(this.gapMsg);
  }
}
