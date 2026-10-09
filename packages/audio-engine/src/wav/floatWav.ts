/**
 * A streaming 32-bit float WAV writer for recorded takes (SPEC §9): `WAVE_FORMAT_IEEE_FLOAT`
 * with a `fact` chunk, interleaved little-endian float samples. The header goes first with zero
 * sizes; once the take ends, {@link FloatWavWriter.finalHeader} (the same length, with the sizes)
 * is written over it. A file whose writer stopped early is fixed by {@link recoverFloatWav} from
 * its length. Pure, so it runs in Node tests and in the take writer worker.
 */

/** Header bytes: RIFF (12) + fmt (8 + 18) + fact (8 + 4) + data header (8). */
export const FLOAT_WAV_HEADER_LENGTH = 58;
/** `WAVE_FORMAT_IEEE_FLOAT`. */
const FORMAT_FLOAT = 3;
const BYTES_PER_SAMPLE = 4;
/** RIFF sizes are 32-bit: the RIFF chunk size (file length − 8) must fit. */
const RIFF_MAX = 0xffff_ffff;

/** Most frames a float WAV of `channels` channels can hold (the 4 GiB RIFF limit). */
export function floatWavMaxFrames(channels: number): number {
  return Math.floor((RIFF_MAX - (FLOAT_WAV_HEADER_LENGTH - 8)) / (channels * BYTES_PER_SAMPLE));
}

/** The header for `frames` frames (0 while the length is unknown). */
export function buildFloatWavHeader(
  channels: number,
  sampleRate: number,
  frames: number,
): Uint8Array {
  const out = new Uint8Array(FLOAT_WAV_HEADER_LENGTH);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  const block = channels * BYTES_PER_SAMPLE;
  const data = frames * block;
  ascii(0, "RIFF");
  v.setUint32(4, frames > 0 ? FLOAT_WAV_HEADER_LENGTH - 8 + data : 0, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 18, true);
  v.setUint16(20, FORMAT_FLOAT, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * block, true);
  v.setUint16(32, block, true);
  v.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  v.setUint16(36, 0, true); // cbSize
  ascii(38, "fact");
  v.setUint32(42, 4, true);
  v.setUint32(46, frames, true);
  ascii(50, "data");
  v.setUint32(54, data, true);
  return out;
}

export interface FloatWavInfo {
  channels: number;
  sampleRate: number;
  /** Frames according to the header (0 for an unfinished file). */
  frames: number;
}

/** Reads a header written by {@link FloatWavWriter}; null when it is not one. */
export function parseFloatWavHeader(bytes: Uint8Array): FloatWavInfo | null {
  if (bytes.length < FLOAT_WAV_HEADER_LENGTH) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, FLOAT_WAV_HEADER_LENGTH);
  const ascii = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (
    ascii(0) !== "RIFF" ||
    ascii(8) !== "WAVE" ||
    ascii(12) !== "fmt " ||
    v.getUint32(16, true) !== 18 ||
    v.getUint16(20, true) !== FORMAT_FLOAT ||
    v.getUint16(34, true) !== BYTES_PER_SAMPLE * 8 ||
    ascii(38) !== "fact" ||
    ascii(50) !== "data"
  )
    return null;
  const channels = v.getUint16(22, true);
  if (channels < 1 || channels > 2) return null;
  return { channels, sampleRate: v.getUint32(24, true), frames: v.getUint32(46, true) };
}

export interface FloatWavWriterOptions {
  channels: number;
  sampleRate?: number;
}

/** Streams planar float chunks out as the bytes of a float WAV (see the module comment). */
export class FloatWavWriter {
  readonly channels: number;
  readonly sampleRate: number;
  private total = 0;

  constructor(opts: FloatWavWriterOptions) {
    if (opts.channels !== 1 && opts.channels !== 2) throw new Error("WAV: 1 or 2 channels");
    this.channels = opts.channels;
    this.sampleRate = opts.sampleRate ?? 48_000;
  }

  /** Frames written so far. */
  get totalSamples(): number {
    return this.total;
  }

  /** The header with zero sizes (the length is not known yet). */
  header(): Uint8Array {
    return buildFloatWavHeader(this.channels, this.sampleRate, 0);
  }

  /**
   * The bytes of `frames` frames of planar floats (±1 = full scale), interleaved; values beyond
   * ±1 are kept (no clipping in a float file).
   */
  encode(planar: readonly Float32Array[], frames?: number): Uint8Array {
    if (planar.length !== this.channels) throw new Error("WAV: channel count");
    const n = frames ?? planar[0]?.length ?? 0;
    const ch = this.channels;
    const out = new Uint8Array(n * ch * BYTES_PER_SAMPLE);
    const v = new DataView(out.buffer);
    for (let c = 0; c < ch; c++) {
      const src = planar[c] as Float32Array;
      let at = c * BYTES_PER_SAMPLE;
      for (let i = 0; i < n; i++) {
        v.setFloat32(at, src[i] as number, true);
        at += ch * BYTES_PER_SAMPLE;
      }
    }
    this.total += n;
    return out;
  }

  /** Nothing is buffered: no bytes (the same shape as the FLAC encoder). */
  finish(): Uint8Array {
    return new Uint8Array(0);
  }

  /** The header with the sizes of what was written, to write at offset 0. */
  finalHeader(): Uint8Array {
    return buildFloatWavHeader(this.channels, this.sampleRate, this.total);
  }
}

export interface RecoveredFloatWav {
  /** File length holding the header and the whole frames: truncate the file to it. */
  validLength: number;
  frames: number;
  /** The header with the sizes, to write at offset 0. */
  header: Uint8Array;
}

/**
 * Crash recovery of a float take: the sizes follow from the file length (whole frames only; a
 * cut-off last frame is dropped). `head` is the file's first {@link FLOAT_WAV_HEADER_LENGTH}
 * bytes. Throws when it is not our float WAV.
 */
export function recoverFloatWav(head: Uint8Array, fileLength: number): RecoveredFloatWav {
  const info = parseFloatWavHeader(head);
  if (!info || fileLength < FLOAT_WAV_HEADER_LENGTH) throw new Error("WAV: not a float take");
  const block = info.channels * BYTES_PER_SAMPLE;
  const frames = Math.min(
    Math.floor((fileLength - FLOAT_WAV_HEADER_LENGTH) / block),
    floatWavMaxFrames(info.channels),
  );
  return {
    validLength: FLOAT_WAV_HEADER_LENGTH + frames * block,
    frames,
    header: buildFloatWavHeader(info.channels, info.sampleRate, frames),
  };
}
