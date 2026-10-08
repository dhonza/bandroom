// Loader for stretch.wasm (native/wrapper.cpp): instantiates the standalone WASM from bytes with
// no Emscripten JS glue, so the same code runs in the decoder worker and in Node.

/** Quality and size settings of one stretcher (see `profiles.ts`). */
export interface StretcherConfig {
  channels: number;
  blockSamples: number;
  intervalSamples: number;
  splitComputation: boolean;
  /** Largest input frame count passed to one `process()`/`seek()` call. */
  maxIn: number;
  /** Largest output frame count requested from one `process()`/`flush()` call. */
  maxOut: number;
}

interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  br_create(
    channels: number,
    block: number,
    interval: number,
    split: number,
    maxIn: number,
    maxOut: number,
  ): number;
  br_destroy(h: number): void;
  br_input(h: number): number;
  br_output(h: number): number;
  br_block_samples(h: number): number;
  br_interval_samples(h: number): number;
  br_input_latency(h: number): number;
  br_output_latency(h: number): number;
  br_set_transpose(h: number, semitones: number, tonalityLimit: number): void;
  br_set_formant(h: number, compensate: number, base: number, shift: number): void;
  br_reset(h: number): void;
  br_seek(h: number, frames: number, rate: number): void;
  br_process(h: number, inFrames: number, outFrames: number): void;
  br_flush(h: number, outFrames: number): void;
}

const SAMPLE_RATE = 48_000;
const WASI_EBADF = 8;

// The module links Emscripten's standalone libc, which imports a few WASI calls for stdio. The
// wrapper never prints, so they only have to exist.
const imports: WebAssembly.Imports = {
  env: { emscripten_notify_memory_growth: () => {} },
  wasi_snapshot_preview1: {
    fd_close: () => WASI_EBADF,
    fd_write: () => WASI_EBADF,
    fd_seek: () => WASI_EBADF,
  },
};

/** One instantiated stretch.wasm; creates any number of stretchers sharing its memory. */
export class StretchModule {
  private constructor(private readonly x: Exports) {}

  static async instantiate(source: BufferSource | WebAssembly.Module): Promise<StretchModule> {
    const module =
      source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
    const instance = await WebAssembly.instantiate(module, imports);
    const x = instance.exports as unknown as Exports;
    x._initialize();
    return new StretchModule(x);
  }

  create(config: StretcherConfig): Stretcher {
    const h = this.x.br_create(
      config.channels,
      config.blockSamples,
      config.intervalSamples,
      config.splitComputation ? 1 : 0,
      config.maxIn,
      config.maxOut,
    );
    if (h === 0) throw new Error("stretch: out of memory");
    return new Stretcher(this.x, h, config);
  }
}

/** One Signalsmith Stretch instance with planar input/output buffers inside WASM memory. */
export class Stretcher {
  readonly channels: number;
  readonly maxIn: number;
  readonly maxOut: number;
  readonly blockSamples: number;
  readonly intervalSamples: number;
  readonly inputLatency: number;
  readonly outputLatency: number;
  private inPtr: number;
  private outPtr: number;
  private buffer: ArrayBuffer | null = null;
  private ins: Float32Array[] = [];
  private outs: Float32Array[] = [];
  private disposed = false;

  constructor(
    private readonly x: Exports,
    private readonly h: number,
    config: StretcherConfig,
  ) {
    this.channels = config.channels;
    this.maxIn = config.maxIn;
    this.maxOut = config.maxOut;
    this.blockSamples = x.br_block_samples(h);
    this.intervalSamples = x.br_interval_samples(h);
    this.inputLatency = x.br_input_latency(h);
    this.outputLatency = x.br_output_latency(h);
    this.inPtr = x.br_input(h);
    this.outPtr = x.br_output(h);
  }

  /** Frames of input `seek()` uses at most (one block + one interval). */
  get seekLength(): number {
    return this.blockSamples + this.intervalSamples;
  }

  /** Input buffer of channel `c` (`maxIn` frames). Valid until the next call into the module. */
  input(c: number): Float32Array {
    return this.view("in", c);
  }

  /** Output buffer of channel `c` (`maxOut` frames). Valid until the next call into the module. */
  output(c: number): Float32Array {
    return this.view("out", c);
  }

  setTranspose(semitones: number, tonalityHz: number): void {
    this.x.br_set_transpose(this.h, semitones, tonalityHz / SAMPLE_RATE);
  }

  /**
   * Keeps the formants in place (`compensate`) and/or moves them by `shiftSemitones`; `baseHz` =
   * rough fundamental, 0 = estimate.
   */
  setFormant(compensate: boolean, baseHz: number, shiftSemitones = 0): void {
    this.x.br_set_formant(this.h, compensate ? 1 : 0, baseHz / SAMPLE_RATE, shiftSemitones);
  }

  reset(): void {
    this.x.br_reset(this.h);
  }

  /** Pre-roll from the first `frames` of the input buffer (ending at the next input position). */
  seek(frames: number, rate: number): void {
    this.check(frames, this.maxIn);
    this.x.br_seek(this.h, frames, rate);
  }

  process(inFrames: number, outFrames: number): void {
    this.check(inFrames, this.maxIn);
    this.check(outFrames, this.maxOut);
    this.x.br_process(this.h, inFrames, outFrames);
  }

  flush(outFrames: number): void {
    this.check(outFrames, this.maxOut);
    this.x.br_flush(this.h, outFrames);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.x.br_destroy(this.h);
    this.ins = [];
    this.outs = [];
    this.buffer = null;
  }

  private check(frames: number, max: number): void {
    if (this.disposed) throw new Error("stretch: disposed");
    if (!Number.isInteger(frames) || frames < 0 || frames > max) {
      throw new RangeError(`stretch: ${frames} frames (max ${max})`);
    }
  }

  private view(kind: "in" | "out", c: number): Float32Array {
    this.refresh();
    const v = (kind === "in" ? this.ins : this.outs)[c];
    if (!v) throw new RangeError(`stretch: channel ${c}`);
    return v;
  }

  // Memory growth replaces the ArrayBuffer, so the views are rebuilt when it changed.
  private refresh(): void {
    const buffer = this.x.memory.buffer;
    if (buffer === this.buffer) return;
    this.buffer = buffer;
    this.ins = [];
    this.outs = [];
    for (let c = 0; c < this.channels; c++) {
      this.ins.push(new Float32Array(buffer, this.inPtr + c * this.maxIn * 4, this.maxIn));
      this.outs.push(new Float32Array(buffer, this.outPtr + c * this.maxOut * 4, this.maxOut));
    }
  }
}
