/**
 * UUIDv7 (RFC 9562): 48-bit Unix ms timestamp, version, 12-bit sequence, variant, 62 random bits.
 * Time-sortable as strings, which keeps SQLite primary-key indexes append-mostly (SPEC §4).
 *
 * Monotonic within a process (RFC 9562 §6.2, method 1): ids generated in the same millisecond get
 * an increasing 12-bit counter, so e.g. activity events keep their insertion order.
 */
let lastMs = -1;
let seq = 0;

export function uuidv7(
  now: number = Date.now(),
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b),
): string {
  let ms = Math.floor(now);
  if (ms > lastMs) {
    lastMs = ms;
    const r = new Uint8Array(2);
    random(r);
    seq = ((r[0] ?? 0) << 4) | ((r[1] ?? 0) >> 4); // random start, upper half free for increments
    seq &= 0x7ff;
  } else {
    ms = lastMs;
    seq++;
    if (seq > 0xfff) {
      // Counter exhausted: borrow the next millisecond.
      lastMs = ms = lastMs + 1;
      seq = 0;
    }
  }

  const bytes = new Uint8Array(16);
  random(bytes.subarray(8));
  let ts = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = 0x70 | (seq >> 8); // version 7 + high 4 bits of the sequence
  bytes[7] = seq & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
