import { crc16Byte, crc8 } from "./crc";
import {
  buildStreamInfo,
  FLAC_STREAMINFO_LENGTH,
  FLAC_STREAMINFO_OFFSET,
  parseStreamInfo,
} from "./encoder";

/**
 * Crash recovery of a take (SPEC §9): re-derives STREAMINFO from the complete frames of a FLAC
 * file whose writer stopped early (header totals unknown, maybe a cut-off last frame). Frames are
 * found by their sync code, header CRC-8, consecutive frame numbers and frame CRC-16. Feed the
 * file in chunks of any size; memory stays around one frame.
 */
export interface RecoveredFlac {
  /** File length holding the header and the complete frames: truncate the file to it. */
  validLength: number;
  frames: number;
  totalSamples: number;
  /** STREAMINFO body to write at {@link FLAC_STREAMINFO_OFFSET}. */
  streamInfo: Uint8Array;
}

interface FrameHeader {
  length: number;
  blockSize: number;
  number: number;
}

/** Longest frame header: 4 fixed bytes, 7 for the number, 2 + 2 optional, CRC-8. */
const MAX_HEADER = 16;

export class FlacRecovery {
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  /** File offset of `buf[0]`. */
  private base = 0;
  private headerEnd = -1;
  private info: ReturnType<typeof parseStreamInfo> | null = null;
  private current: FrameHeader | null = null;
  private broken = false;
  /** CRC-16 of buf[0, scan). */
  private crc = 0;
  private scan = 0;
  private frames = 0;
  private total = 0;
  private minFrame = Number.POSITIVE_INFINITY;
  private maxFrame = 0;

  push(chunk: Uint8Array): void {
    if (this.broken) return;
    if (this.len + chunk.length > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + chunk.length));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    this.process(false);
  }

  finish(): RecoveredFlac {
    this.process(true);
    if (!this.info) throw new Error("FLAC: no stream header");
    const frames = this.frames > 0;
    return {
      validLength: this.base,
      frames: this.frames,
      totalSamples: this.total,
      streamInfo: buildStreamInfo({
        ...this.info,
        minFrameSize: frames ? this.minFrame : 0,
        maxFrameSize: frames ? this.maxFrame : 0,
        totalSamples: this.total,
      }),
    };
  }

  private process(final: boolean): void {
    if (this.headerEnd < 0 && !this.readHeader()) return;
    while (!this.broken) {
      if (!this.current) {
        const h = this.frameHeaderAt(0, final);
        if (h === "more") return;
        // Frames are numbered from 0; anything else after the last good frame ends the scan.
        if (h === null || h.number !== this.frames) {
          this.broken = true;
          return;
        }
        this.current = h;
        this.crc = 0;
        this.scan = 0;
      }
      if (!this.findFrameEnd(final)) return;
    }
  }

  /** Scans for the end of the current frame; true when one was found and consumed. */
  private findFrameEnd(final: boolean): boolean {
    const cur = this.current as FrameHeader;
    const limit = final ? this.len : this.len - MAX_HEADER;
    let crc = this.crc;
    let i = this.scan;
    for (; i < limit; i++) {
      // crc covers buf[0, i): zero means buf[i−2, i) is a matching CRC-16.
      if (crc === 0 && i > cur.length + 2 && this.buf[i] === 0xff) {
        const next = this.frameHeaderAt(i, final);
        if (next !== null && next !== "more" && next.number === cur.number + 1) {
          this.consume(i);
          return true;
        }
      }
      crc = crc16Byte(crc, this.buf[i] as number);
    }
    this.crc = crc;
    this.scan = i;
    if (final && crc === 0 && this.len > cur.length + 2) {
      this.consume(this.len); // the last frame runs to the end of the file
      return true;
    }
    if (final) this.broken = true; // a cut-off last frame is dropped
    return false;
  }

  private consume(size: number): void {
    const cur = this.current as FrameHeader;
    this.frames++;
    this.total += cur.blockSize;
    if (size < this.minFrame) this.minFrame = size;
    if (size > this.maxFrame) this.maxFrame = size;
    this.buf.copyWithin(0, size, this.len);
    this.len -= size;
    this.base += size;
    this.current = null;
  }

  /** "fLaC" and the metadata blocks; the first is STREAMINFO. */
  private readHeader(): boolean {
    const b = this.buf;
    if (this.len < 4) return false;
    if (b[0] !== 0x66 || b[1] !== 0x4c || b[2] !== 0x61 || b[3] !== 0x43) {
      throw new Error("FLAC: not a FLAC file");
    }
    let pos = 4;
    for (;;) {
      if (this.len < pos + 4) return false;
      const last = ((b[pos] as number) & 0x80) !== 0;
      const size =
        ((b[pos + 1] as number) << 16) | ((b[pos + 2] as number) << 8) | (b[pos + 3] as number);
      if (pos === 4) {
        if (((b[pos] as number) & 0x7f) !== 0 || size !== FLAC_STREAMINFO_LENGTH)
          throw new Error("FLAC: STREAMINFO missing");
        if (this.len < FLAC_STREAMINFO_OFFSET + FLAC_STREAMINFO_LENGTH) return false;
        this.info = parseStreamInfo(b.subarray(FLAC_STREAMINFO_OFFSET));
      }
      pos += 4 + size;
      if (last) break;
    }
    if (this.len < pos) return false;
    this.headerEnd = pos;
    this.consumeHeader(pos);
    return true;
  }

  private consumeHeader(size: number): void {
    this.buf.copyWithin(0, size, this.len);
    this.len -= size;
    this.base += size;
  }

  /** Parses a frame header at `at`: null if invalid, "more" if it needs more bytes. */
  private frameHeaderAt(at: number, final: boolean): FrameHeader | null | "more" {
    const b = this.buf;
    const avail = this.len - at;
    if (avail < MAX_HEADER && !final) return "more";
    const byte = (i: number) => (at + i < this.len ? (b[at + i] as number) : -1);
    if (byte(0) !== 0xff || (byte(1) & 0xfe) !== 0xf8) return null;
    const b2 = byte(2);
    const b3 = byte(3);
    if (b2 < 0 || b3 < 0) return null;
    const bsCode = b2 >> 4;
    const rateCode = b2 & 0xf;
    if (bsCode === 0 || rateCode === 15 || b3 >> 4 > 10 || (b3 & 1) !== 0) return null;
    if (((b3 >> 1) & 7) === 3 || ((b3 >> 1) & 7) === 7) return null;
    let pos = 4;
    // Frame number in FLAC's UTF-8-like coding.
    const lead = byte(pos++);
    if (lead < 0) return null;
    let number: number;
    let extra: number;
    if (lead < 0x80) [number, extra] = [lead, 0];
    else if (lead >= 0xc0 && lead < 0xe0) [number, extra] = [lead & 0x1f, 1];
    else if (lead >= 0xe0 && lead < 0xf0) [number, extra] = [lead & 0x0f, 2];
    else if (lead >= 0xf0 && lead < 0xf8) [number, extra] = [lead & 0x07, 3];
    else if (lead >= 0xf8 && lead < 0xfc) [number, extra] = [lead & 0x03, 4];
    else if (lead >= 0xfc && lead < 0xfe) [number, extra] = [lead & 0x01, 5];
    else return null;
    for (let k = 0; k < extra; k++) {
      const c = byte(pos++);
      if (c < 0 || (c & 0xc0) !== 0x80) return null;
      number = number * 64 + (c & 0x3f);
    }
    let blockSize: number;
    if (bsCode === 1) blockSize = 192;
    else if (bsCode <= 5) blockSize = 576 << (bsCode - 2);
    else if (bsCode === 6) blockSize = byte(pos++) + 1;
    else if (bsCode === 7) {
      blockSize = ((byte(pos) << 8) | byte(pos + 1)) + 1;
      pos += 2;
    } else blockSize = 256 << (bsCode - 8);
    if (rateCode === 12) pos += 1;
    else if (rateCode === 13 || rateCode === 14) pos += 2;
    if (pos >= avail) return null;
    if (crc8(b, at, at + pos) !== byte(pos)) return null;
    return { length: pos + 1, blockSize, number };
  }
}

/** Recovers a whole file held in memory (see {@link FlacRecovery}). */
export function recoverFlac(bytes: Uint8Array): RecoveredFlac {
  const r = new FlacRecovery();
  r.push(bytes);
  return r.finish();
}
