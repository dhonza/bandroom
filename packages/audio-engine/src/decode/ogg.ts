/**
 * Incremental Ogg demuxer for Opus (RFC 3533, RFC 7845). Bytes arrive in arbitrary chunks from a
 * streaming fetch or a Range read that starts at a page boundary; pages come out as soon as they
 * are complete. Packets that continue from a page we never saw (after a seek) are dropped.
 */

export interface OggPacketPage {
  /** Absolute granule position, or -1 when no packet completes on this page. */
  granule: number;
  /** Header type flags: 0x01 continued, 0x02 BOS, 0x04 EOS. */
  flags: number;
  /** Packets that complete on this page, in order. */
  packets: Uint8Array[];
  /** True when the page began with the tail of a packet whose start was not seen. */
  droppedContinuation: boolean;
}

const CAPTURE = 0x4f676753; // "OggS"

export class OggDemuxer {
  private buf: Uint8Array = new Uint8Array(0);
  /** Start of an incomplete packet carried over from the previous page. */
  private partial: Uint8Array[] = [];
  private seenPage = false;

  /** Feeds bytes and returns every page completed by them. */
  push(bytes: Uint8Array): OggPacketPage[] {
    this.buf = this.buf.length === 0 ? bytes : concat([this.buf, bytes]);
    const pages: OggPacketPage[] = [];
    let pos = 0;
    for (;;) {
      const page = this.readPage(pos);
      if (!page) break;
      pages.push(page.page);
      pos = page.next;
    }
    this.buf = pos === 0 ? this.buf : this.buf.slice(pos);
    return pages;
  }

  private readPage(pos: number): { page: OggPacketPage; next: number } | null {
    const b = this.buf;
    if (b.length - pos < 27) return null;
    const view = new DataView(b.buffer, b.byteOffset + pos);
    if (view.getUint32(0) !== CAPTURE) throw new Error(`Bad Ogg capture pattern at ${pos}`);
    const nSeg = b[pos + 26] ?? 0;
    if (b.length - pos < 27 + nSeg) return null;
    let bodyLen = 0;
    for (let i = 0; i < nSeg; i++) bodyLen += b[pos + 27 + i] ?? 0;
    const bodyStart = pos + 27 + nSeg;
    if (b.length < bodyStart + bodyLen) return null;

    const flags = b[pos + 5] ?? 0;
    const lo = view.getUint32(6, true);
    const hi = view.getInt32(10, true);
    const granule = hi === -1 && lo === 0xffffffff ? -1 : hi * 2 ** 32 + lo;

    const packets: Uint8Array[] = [];
    let droppedContinuation = false;
    if ((flags & 0x01) !== 0 && (this.partial.length === 0 || !this.seenPage)) {
      droppedContinuation = true;
      this.partial = [];
    } else if ((flags & 0x01) === 0) {
      this.partial = [];
    }
    let segStart = bodyStart;
    let skipping = droppedContinuation;
    for (let i = 0; i < nSeg; i++) {
      const lace = b[pos + 27 + i] ?? 0;
      const segEnd = segStart + lace;
      if (!skipping) this.partial.push(b.slice(segStart, segEnd));
      segStart = segEnd;
      if (lace < 255) {
        if (!skipping) packets.push(concat(this.partial));
        this.partial = [];
        skipping = false;
      }
    }
    this.seenPage = true;
    return {
      page: { granule, flags, packets, droppedContinuation },
      next: bodyStart + bodyLen,
    };
  }
}

/** Samples at 48 kHz in one Opus packet (RFC 6716 §3.1, TOC byte and frame count code). */
export function opusPacketSamples(packet: Uint8Array): number {
  const toc = packet[0];
  if (toc === undefined) return 0;
  const config = toc >> 3;
  let frame: number;
  if (config < 12)
    frame = [480, 960, 1920, 2880][config & 3] ?? 960; // SILK 10/20/40/60 ms
  else if (config < 16)
    frame = (config & 1) === 0 ? 480 : 960; // Hybrid 10/20 ms
  else frame = [120, 240, 480, 960][config & 3] ?? 960; // CELT 2.5/5/10/20 ms
  const code = toc & 3;
  const count = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  return frame * count;
}

export function isOpusHeaderPacket(p: Uint8Array): boolean {
  if (p.length < 8 || p[0] !== 0x4f || p[1] !== 0x70 || p[2] !== 0x75 || p[3] !== 0x73)
    return false;
  const tag = String.fromCharCode(p[4] ?? 0, p[5] ?? 0, p[6] ?? 0, p[7] ?? 0);
  return tag === "Head" || tag === "Tags";
}

export function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0]) return parts[0];
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
