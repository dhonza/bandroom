import { concat } from "./ogg";

/**
 * FLAC frame splitter (RFC 9639 §9). A frame starts with a sync code and a header protected by
 * CRC-8, and ends where the next valid header begins; the CRC-16 over the whole frame (footer
 * included) is then 0. The WASM decoder receives whole frames, so the last frame of a file is
 * never lost (the bundled codec-parser drops very small final frames).
 */

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}

/** Length of a valid frame header at `p`, or 0 (not a header, or not enough bytes to tell). */
export function flacHeaderLength(b: Uint8Array, p: number): number {
  if (b[p] !== 0xff || ((b[p + 1] ?? 0) & 0xfe) !== 0xf8) return 0;
  const b2 = b[p + 2];
  const b3 = b[p + 3];
  if (b2 === undefined || b3 === undefined) return 0;
  const bs = b2 >> 4;
  const sr = b2 & 0x0f;
  const ch = b3 >> 4;
  if (bs === 0 || sr === 15 || ch >= 11 || (b3 & 1) !== 0) return 0;
  // UTF-8-style coded frame/sample number.
  const first = b[p + 4];
  if (first === undefined) return 0;
  let n = 1;
  if (first >= 0x80) {
    if ((first & 0xc0) === 0x80 || first === 0xff) return 0;
    let m = first;
    n = 0;
    while (m & 0x80) {
      n++;
      m <<= 1;
    }
  }
  let len = 4 + n;
  if (bs === 6) len += 1;
  else if (bs === 7) len += 2;
  if (sr === 12) len += 1;
  else if (sr === 13 || sr === 14) len += 2;
  if (p + len >= b.length) return 0;
  let crc = 0;
  for (let i = p; i < p + len; i++) crc = CRC8[crc ^ (b[i] ?? 0)] ?? 0;
  return crc === (b[p + len] ?? -1) ? len + 1 : 0;
}

export class FlacFrameSplitter {
  private buf: Uint8Array = new Uint8Array(0);
  /** Start of the current frame in `buf` (−1 until synced). */
  private start = -1;
  /** Scan position and running CRC-16 of `buf[start, scan)`. */
  private scan = 0;
  private crc = 0;

  push(bytes: Uint8Array, final = false): Uint8Array[] {
    this.buf = this.buf.length === 0 ? bytes : concat([this.buf, bytes]);
    const frames: Uint8Array[] = [];
    const b = this.buf;
    if (this.start < 0) {
      for (let p = this.scan; p + 16 < b.length; p++) {
        if (flacHeaderLength(b, p) > 0) {
          this.start = p;
          this.scan = p;
          this.crc = 0;
          break;
        }
        this.scan = p + 1;
      }
      if (this.start < 0) return frames;
    }
    // Headers are at most 16 bytes; stop early enough to always judge a candidate completely.
    const limit = final ? b.length : b.length - 16;
    let crc = this.crc; // CRC-16 of b[start, p)
    let p = this.scan;
    for (; p < limit; p++) {
      const v = b[p] ?? 0;
      if (v === 0xff && crc === 0 && p > this.start + 6 && flacHeaderLength(b, p) > 0) {
        frames.push(b.slice(this.start, p));
        this.start = p;
      }
      crc = ((crc << 8) ^ (CRC16[((crc >> 8) ^ v) & 0xff] ?? 0)) & 0xffff;
    }
    this.crc = crc;
    this.scan = p;
    if (this.start > 0) {
      this.buf = b.slice(this.start);
      this.scan -= this.start;
      this.start = 0;
    }
    return frames;
  }

  /** The final frame (the rest of the stream) when its CRC checks out. */
  flush(): Uint8Array[] {
    const frames = this.push(new Uint8Array(0), true);
    if (this.start < 0) return frames;
    const b = this.buf;
    let crc = 0;
    for (let i = this.start; i < b.length; i++)
      crc = ((crc << 8) ^ (CRC16[((crc >> 8) ^ (b[i] ?? 0)) & 0xff] ?? 0)) & 0xffff;
    const last = b.slice(this.start);
    this.buf = new Uint8Array(0);
    this.start = -1;
    this.scan = 0;
    if (crc === 0 && last.length > 0) frames.push(last);
    return frames;
  }
}
