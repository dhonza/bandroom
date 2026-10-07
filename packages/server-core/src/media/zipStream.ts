import { crc32 } from "node:zlib";

/**
 * A streamed, uncompressed (STORED) ZIP writer (SPEC §28.7): no dependency, no temp file, exact
 * size known before the first byte (`Content-Length`). Entries are read once; the CRC goes into a
 * data descriptor after each entry (general purpose bit 3). Names are UTF-8 (bit 11). ZIP64
 * records are used for every entry when the archive needs them (an entry or offset ≥ 4 GiB, or
 * more than 65 535 entries).
 */

export interface ZipEntry {
  /** Path inside the archive, `/`-separated. */
  name: string;
  /** Exact number of bytes `open` yields (checked). */
  size: number;
  open: (signal?: AbortSignal) => AsyncIterable<Uint8Array>;
}

export interface ZipPlan {
  totalSize: number;
  zip64: boolean;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const FLAGS = 0x0808; // bit 3: data descriptor; bit 11: UTF-8 names
const MADE_BY = (3 << 8) | 63; // UNIX, spec 6.3
const FILE_MODE = 0o100644;

const LOCAL = 30;
const CENTRAL = 46;
const EOCD = 22;
const ZIP64_EOCD = 56;
const ZIP64_LOCATOR = 20;
const LOCAL_EXTRA64 = 20; // header 4 + sizes 16
const CENTRAL_EXTRA64 = 28; // header 4 + sizes 16 + offset 8
const DESCRIPTOR = 16;
const DESCRIPTOR64 = 24;

function layout(entries: readonly { name: string; size: number }[], zip64: boolean) {
  let offset = 0;
  let central = 0;
  let maxOffset = 0;
  for (const e of entries) {
    const n = Buffer.byteLength(e.name, "utf8");
    maxOffset = Math.max(maxOffset, offset);
    offset +=
      LOCAL + n + (zip64 ? LOCAL_EXTRA64 : 0) + e.size + (zip64 ? DESCRIPTOR64 : DESCRIPTOR);
    central += CENTRAL + n + (zip64 ? CENTRAL_EXTRA64 : 0);
  }
  const end = zip64 ? ZIP64_EOCD + ZIP64_LOCATOR + EOCD : EOCD;
  return {
    centralOffset: offset,
    centralSize: central,
    maxOffset,
    totalSize: offset + central + end,
  };
}

/** The exact archive size and whether it needs ZIP64. */
export function planZip(entries: readonly { name: string; size: number }[]): ZipPlan {
  const small = layout(entries, false);
  const zip64 =
    entries.length > MAX16 - 1 ||
    entries.some((e) => e.size >= MAX32) ||
    small.maxOffset >= MAX32 ||
    small.centralOffset >= MAX32 ||
    small.centralSize >= MAX32;
  return { totalSize: (zip64 ? layout(entries, true) : small).totalSize, zip64 };
}

/** MS-DOS date and time of `ms` (local time, 2 s resolution, from 1980). */
function dosDateTime(ms: number): { date: number; time: number } {
  const d = new Date(Math.max(ms, Date.UTC(1980, 0, 1, 12)));
  return {
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

function u64(buf: Buffer, value: number, at: number): void {
  buf.writeBigUInt64LE(BigInt(value), at);
}

/**
 * Writes the archive. Throws when an entry yields a different number of bytes than its `size`
 * (the response would be corrupt otherwise) or when `signal` aborts.
 */
export async function* writeZip(
  entries: readonly ZipEntry[],
  signal?: AbortSignal,
  now: number = Date.now(),
): AsyncGenerator<Buffer> {
  const { zip64 } = planZip(entries);
  const { date, time } = dosDateTime(now);
  const records: { name: Buffer; size: number; crc: number; offset: number }[] = [];
  let offset = 0;
  for (const e of entries) {
    signal?.throwIfAborted();
    const name = Buffer.from(e.name, "utf8");
    const local = Buffer.alloc(LOCAL + name.length + (zip64 ? LOCAL_EXTRA64 : 0));
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14); // CRC in the data descriptor
    // The sizes are known: readers that stream (no central directory) can still find the end.
    local.writeUInt32LE(zip64 ? MAX32 : e.size, 18);
    local.writeUInt32LE(zip64 ? MAX32 : e.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(zip64 ? LOCAL_EXTRA64 : 0, 28);
    name.copy(local, LOCAL);
    if (zip64) {
      const x = LOCAL + name.length;
      local.writeUInt16LE(0x0001, x);
      local.writeUInt16LE(16, x + 2);
      u64(local, e.size, x + 4);
      u64(local, e.size, x + 12);
    }
    yield local;
    let crc = 0;
    let written = 0;
    for await (const chunk of e.open(signal)) {
      signal?.throwIfAborted();
      if (chunk.length === 0) continue;
      crc = crc32(chunk, crc);
      written += chunk.length;
      if (written > e.size) break;
      yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (written !== e.size)
      throw new Error(
        `zip entry ${e.name}: expected ${String(e.size)} bytes, got ${String(written)}`,
      );
    const desc = Buffer.alloc(zip64 ? DESCRIPTOR64 : DESCRIPTOR);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    if (zip64) {
      u64(desc, e.size, 8);
      u64(desc, e.size, 16);
    } else {
      desc.writeUInt32LE(e.size, 8);
      desc.writeUInt32LE(e.size, 12);
    }
    yield desc;
    records.push({ name, size: e.size, crc: crc >>> 0, offset });
    offset += local.length + e.size + desc.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const r of records) {
    const c = Buffer.alloc(CENTRAL + r.name.length + (zip64 ? CENTRAL_EXTRA64 : 0));
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(MADE_BY, 4);
    c.writeUInt16LE(zip64 ? 45 : 20, 6);
    c.writeUInt16LE(FLAGS, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(r.crc, 16);
    c.writeUInt32LE(zip64 ? MAX32 : r.size, 20);
    c.writeUInt32LE(zip64 ? MAX32 : r.size, 24);
    c.writeUInt16LE(r.name.length, 28);
    c.writeUInt16LE(zip64 ? CENTRAL_EXTRA64 : 0, 30);
    c.writeUInt16LE(0, 32); // comment
    c.writeUInt16LE(0, 34); // disk
    c.writeUInt16LE(0, 36); // internal attributes
    c.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
    c.writeUInt32LE(zip64 ? MAX32 : r.offset, 42);
    r.name.copy(c, CENTRAL);
    if (zip64) {
      const x = CENTRAL + r.name.length;
      c.writeUInt16LE(0x0001, x);
      c.writeUInt16LE(24, x + 2);
      u64(c, r.size, x + 4);
      u64(c, r.size, x + 12);
      u64(c, r.offset, x + 20);
    }
    centralSize += c.length;
    yield c;
  }

  if (zip64) {
    const z = Buffer.alloc(ZIP64_EOCD + ZIP64_LOCATOR);
    z.writeUInt32LE(0x06064b50, 0);
    u64(z, ZIP64_EOCD - 12, 4);
    z.writeUInt16LE(MADE_BY, 12);
    z.writeUInt16LE(45, 14);
    z.writeUInt32LE(0, 16);
    z.writeUInt32LE(0, 20);
    u64(z, records.length, 24);
    u64(z, records.length, 32);
    u64(z, centralSize, 40);
    u64(z, centralOffset, 48);
    z.writeUInt32LE(0x07064b50, 56);
    z.writeUInt32LE(0, 60);
    u64(z, centralOffset + centralSize, 64);
    z.writeUInt32LE(1, 72);
    yield z;
  }
  const end = Buffer.alloc(EOCD);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(zip64 ? MAX16 : records.length, 8);
  end.writeUInt16LE(zip64 ? MAX16 : records.length, 10);
  end.writeUInt32LE(zip64 ? MAX32 : centralSize, 12);
  end.writeUInt32LE(zip64 ? MAX32 : centralOffset, 16);
  end.writeUInt16LE(0, 20);
  yield end;
}

// eslint-disable-next-line no-control-regex -- control characters are not allowed in names
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** One safe path segment from a title (no separators, no trailing dots, ≤ 120 characters). */
export function zipPathSegment(name: string): string {
  let s = name.replace(UNSAFE, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  s = s.replace(/[. ]+$/, "");
  if (s === "" || s === "." || s === "..") s = "_";
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

/**
 * `path` itself when not taken yet, else "‹name› (2).‹ext›", "(3)", …; compared without case
 * (macOS and Windows file systems). Adds the result to `taken`.
 */
export function uniquePath(taken: Set<string>, path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ""];
  let candidate = path;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++)
    candidate = `${dir}${stem} (${String(n)})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}
