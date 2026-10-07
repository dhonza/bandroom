import { SAMPLE_RATE } from "../constants";
import { FlacFrameSplitter } from "./flacFrames";
import { isOpusHeaderPacket, OggDemuxer, opusPacketSamples } from "./ogg";
import { Resampler, resamplerPlan } from "./resample";

/** Decoded PCM at 48 kHz; `frame` is the first frame's position in the clip source. */
export interface PcmBlock {
  frame: number;
  data: Float32Array[];
}

/** A decoder for one stream position onward: compressed bytes in, positioned PCM out. */
export interface StreamDecoder {
  push(bytes: Uint8Array): Promise<PcmBlock[]>;
  /** Call at the end of the file. */
  flush(): Promise<PcmBlock[]>;
  free(): void;
}

export interface OpusCodec {
  decodeFrames(frames: Uint8Array[]): { channelData: Float32Array[]; samplesDecoded: number };
  free(): void;
}

export interface OpusStreamInfo {
  channels: number;
  preSkip: number;
  /** Decodable samples after pre-skip (`durationSamples48k`). */
  totalSamples: number;
}

/** Keeps `[from, to)` of a block that starts at `frame`; null when nothing is left. */
function clip(frame: number, data: Float32Array[], from: number, to: number): PcmBlock | null {
  const len = data[0]?.length ?? 0;
  const a = Math.max(0, from - frame);
  const b = Math.min(len, to - frame);
  if (b <= a) return null;
  return {
    frame: frame + a,
    data: a === 0 && b === len ? data : data.map((d) => d.subarray(a, b)),
  };
}

/**
 * Ogg Opus from a page boundary onward (SPEC §6.5). Pre-skip is applied here exactly once (the
 * WASM decoder runs with preSkip 0), positions follow packet durations from the TOC, and output is
 * trimmed to `[discardBefore, totalSamples)`, which drops seek pre-roll and end padding.
 */
export class OpusStream implements StreamDecoder {
  private readonly demux = new OggDemuxer();
  /** Decoder sample index (pre-skip included) of the next packet; null until known. */
  private next: number | null = null;
  private done = false;

  constructor(
    private readonly codec: OpusCodec,
    private readonly info: OpusStreamInfo,
    private readonly startDecoded: number | null,
    private readonly discardBefore: number,
  ) {}

  push(bytes: Uint8Array): Promise<PcmBlock[]> {
    try {
      return Promise.resolve(this.decode(bytes));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private decode(bytes: Uint8Array): PcmBlock[] {
    const out: PcmBlock[] = [];
    if (this.done) return out;
    const { preSkip, totalSamples, channels } = this.info;
    for (const page of this.demux.push(bytes)) {
      const packets = page.packets.filter((p) => !isOpusHeaderPacket(p));
      if (packets.length === 0) continue;
      const durations = packets.map(opusPacketSamples);
      if (this.next === null) {
        if (!page.droppedContinuation && this.startDecoded !== null) this.next = this.startDecoded;
        else if ((page.flags & 0x04) === 0 && page.granule >= 0)
          this.next = page.granule - durations.reduce((a, b) => a + b, 0);
        else throw new Error("Cannot position Opus stream on its last page");
      }
      const expected = durations.reduce((a, b) => a + b, 0);
      const firstFrame = this.next - preSkip;
      this.next += expected;
      // Pre-roll packets are decoded too (they prime the decoder) and then clipped away.
      const decoded = this.codec.decodeFrames(packets);
      const data = fitLength(decoded.channelData, channels, expected);
      const block = clip(firstFrame, data, this.discardBefore, totalSamples);
      if (block) out.push(block);
      if (this.next - preSkip >= totalSamples) {
        this.done = true;
        break;
      }
    }
    return out;
  }

  flush(): Promise<PcmBlock[]> {
    return Promise.resolve([]);
  }

  free(): void {
    this.codec.free();
  }
}

/**
 * Pads or truncates decoder output to the length the packet headers promise, so a corrupt
 * packet can never shift the timeline.
 */
function fitLength(data: Float32Array[], channels: number, length: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const d = data[c] ?? data[0] ?? new Float32Array(0);
    if (d.length === length) out.push(d);
    else {
      const f = new Float32Array(length);
      f.set(d.subarray(0, length));
      out.push(f);
    }
  }
  return out;
}

export interface FlacCodec {
  decodeFrames(
    frames: Uint8Array[],
  ): Promise<{ channelData: Float32Array[]; samplesDecoded: number }>;
  free(): void;
}

export interface FlacStreamInfo {
  sampleRate: number;
  channels: number;
  /** Source frames in the file. */
  totalFrames: number;
}

/** Frames at 48 kHz for a source length (same rounding as the ingest's `durationSamples48k`). */
export function frames48k(sourceFrames: number, sampleRate: number): number {
  return Math.round((sourceFrames * SAMPLE_RATE) / sampleRate);
}

/** First source frame a 48 kHz output frame needs (decode must start at or before it). */
export function flacSourceStart(frame48: number, sampleRate: number): number {
  if (sampleRate === SAMPLE_RATE) return frame48;
  const { up, down, halfWidth } = resamplerPlan(sampleRate);
  return Math.max(0, Math.floor((frame48 * up) / down) - halfWidth + 1);
}

/**
 * FLAC from a frame boundary onward, resampled to 48 kHz when the source rate differs. The
 * starting source frame comes from the seek index, so positions are exact.
 */
export class FlacStream implements StreamDecoder {
  private src: number; // next source frame
  private out48: number; // next 48 kHz output frame (resampled path)
  private readonly splitter = new FlacFrameSplitter();
  private readonly resampler: Resampler | null;
  private readonly total48: number;

  constructor(
    private readonly codec: FlacCodec,
    private readonly info: FlacStreamInfo,
    startFrame: number,
    private readonly discardBefore: number,
  ) {
    this.src = startFrame;
    this.total48 = frames48k(info.totalFrames, info.sampleRate);
    this.resampler =
      info.sampleRate === SAMPLE_RATE
        ? null
        : new Resampler(
            info.sampleRate,
            info.channels,
            startFrame,
            Math.ceil((startFrame * SAMPLE_RATE) / info.sampleRate),
          );
    this.out48 = this.resampler ? Math.ceil((startFrame * SAMPLE_RATE) / info.sampleRate) : 0;
  }

  async push(bytes: Uint8Array): Promise<PcmBlock[]> {
    const frames = this.splitter.push(bytes);
    if (frames.length === 0) return [];
    return this.emit(await this.codec.decodeFrames(frames), false);
  }

  async flush(): Promise<PcmBlock[]> {
    return this.emit(await this.codec.decodeFrames(this.splitter.flush()), true);
  }

  private emit(
    r: { channelData: Float32Array[]; samplesDecoded: number },
    end: boolean,
  ): PcmBlock[] {
    const data =
      r.samplesDecoded > 0 ? fitLength(r.channelData, this.info.channels, r.samplesDecoded) : [];
    const blocks: PcmBlock[] = [];
    if (!this.resampler) {
      if (data.length > 0) {
        const b = clip(this.src, data, this.discardBefore, this.total48);
        if (b) blocks.push(b);
        this.src += r.samplesDecoded;
      }
      return blocks;
    }
    const parts: Float32Array[][] = [];
    if (data.length > 0) {
      this.src += r.samplesDecoded;
      parts.push(this.resampler.push(data));
    }
    if (end) parts.push(this.resampler.flush());
    for (const p of parts) {
      const n = p[0]?.length ?? 0;
      if (n === 0) continue;
      const b = clip(this.out48, p, this.discardBefore, this.total48);
      this.out48 += n;
      if (b) blocks.push(b);
    }
    return blocks;
  }

  free(): void {
    this.codec.free();
  }
}
