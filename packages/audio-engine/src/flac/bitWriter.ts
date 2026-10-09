/**
 * MSB-first bit writer over a growable byte buffer (FLAC bitstreams). At most 7 bits stay pending
 * between calls, so each write fits a 32-bit accumulator.
 */
export class BitWriter {
  buf: Uint8Array;
  /** Bytes written (complete bytes only). */
  pos = 0;
  private acc = 0;
  private bits = 0;

  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(capacity);
  }

  /** Writes the low `n` bits of `value` (unsigned or two's complement), 0 ≤ n ≤ 32. */
  write(value: number, n: number): void {
    if (n > 24) {
      this.put(Math.floor(value / 0x1000000) & ((1 << (n - 24)) - 1), n - 24);
      this.put(value & 0xffffff, 24);
    } else {
      this.put(n === 0 ? 0 : value & ((1 << n) - 1), n);
    }
  }

  /** `n` zero bits (a unary prefix). */
  zeros(n: number): void {
    while (n > 24) {
      this.put(0, 24);
      n -= 24;
    }
    this.put(0, n);
  }

  /** A Rice code: `q` zeros, a one, then the low `k` bits of `low`. */
  rice(q: number, low: number, k: number): void {
    if (q + 1 + k <= 24) {
      this.put((1 << k) | low, q + 1 + k);
      return;
    }
    this.zeros(q);
    this.put(1, 1);
    this.write(low, k);
  }

  /** `value` must already fit in `n` ≤ 24 bits. */
  private put(value: number, n: number): void {
    this.acc = ((this.acc << n) | value) >>> 0;
    this.bits += n;
    while (this.bits >= 8) {
      this.bits -= 8;
      if (this.pos >= this.buf.length) this.grow();
      this.buf[this.pos++] = (this.acc >>> this.bits) & 0xff;
    }
    this.acc &= (1 << this.bits) - 1;
  }

  /** Pads with zero bits to a byte boundary. */
  align(): void {
    if (this.bits > 0) this.put(0, 8 - this.bits);
  }

  byte(b: number): void {
    this.put(b & 0xff, 8);
  }

  /** The position as a bit count, for rewinding a subframe. */
  mark(): { pos: number; acc: number; bits: number } {
    return { pos: this.pos, acc: this.acc, bits: this.bits };
  }

  rewind(m: { pos: number; acc: number; bits: number }): void {
    this.pos = m.pos;
    this.acc = m.acc;
    this.bits = m.bits;
  }

  bitLength(): number {
    return this.pos * 8 + this.bits;
  }

  /** Copies out the written bytes (byte-aligned) and empties the writer. */
  take(): Uint8Array {
    const out = this.buf.slice(0, this.pos);
    this.pos = 0;
    return out;
  }

  private grow(): void {
    const next = new Uint8Array(this.buf.length * 2);
    next.set(this.buf);
    this.buf = next;
  }
}
