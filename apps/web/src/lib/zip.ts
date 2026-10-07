import { Inflate } from "fflate";

/** Why a zip could not be unpacked (SPEC §28.1). */
export type ZipFailure = "invalid" | "zip64" | "encrypted" | "unsupported" | "corrupt";

export class ZipError extends Error {
  constructor(readonly reason: ZipFailure) {
    super(`zip: ${reason}`);
  }
}

/** A file unpacked from a zip, with its path inside the archive (e.g. "Song/bass.wav"). */
export type ZipEntryFile = File & { path: string };

const ZIP_TYPES = new Set(["application/zip", "application/x-zip-compressed"]);

export function isZipFile(file: File): boolean {
  return ZIP_TYPES.has(file.type) || /\.zip$/i.test(file.name);
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const READ_CHUNK = 1024 * 1024;

interface Entry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

async function bytes(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

const utf8 = new TextDecoder("utf-8");

/** Reads the central directory (the reliable index at the end of the archive). */
async function readEntries(zip: Blob): Promise<Entry[]> {
  if (zip.size < EOCD_MIN) throw new ZipError("invalid");
  const tailStart = Math.max(0, zip.size - EOCD_MIN - MAX_COMMENT);
  const tail = await bytes(zip.slice(tailStart));
  let eocd = -1;
  for (let i = tail.byteLength - EOCD_MIN; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("invalid");
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  // ZIP64 archives (> 4 GB or > 65535 entries) are not supported (SPEC §28.1).
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError("zip64");
  }
  if (cdOffset + cdSize > zip.size) throw new ZipError("invalid");
  const cd = await bytes(zip.slice(cdOffset, cdOffset + cdSize));
  const entries: Entry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== CENTRAL_SIG) {
      throw new ZipError("invalid");
    }
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const entry: Entry = {
      flags: cd.getUint16(p + 8, true),
      method: cd.getUint16(p + 10, true),
      compressedSize: cd.getUint32(p + 20, true),
      size: cd.getUint32(p + 24, true),
      localOffset: cd.getUint32(p + 42, true),
      name: utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen)),
    };
    if (
      entry.compressedSize === 0xffffffff ||
      entry.size === 0xffffffff ||
      entry.localOffset === 0xffffffff
    ) {
      throw new ZipError("zip64");
    }
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Skips folders, macOS resource forks (`__MACOSX/`) and hidden files (any dot segment). */
function isHidden(name: string): boolean {
  if (name.endsWith("/")) return true;
  const parts = name.split("/").filter(Boolean);
  return parts.length === 0 || parts[0] === "__MACOSX" || parts.some((s) => s.startsWith("."));
}

async function entryData(zip: Blob, e: Entry): Promise<Blob> {
  if (e.flags & 1) throw new ZipError("encrypted");
  const local = await bytes(zip.slice(e.localOffset, e.localOffset + 30));
  if (local.byteLength < 30 || local.getUint32(0, true) !== LOCAL_SIG) {
    throw new ZipError("invalid");
  }
  const start = e.localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  const data = zip.slice(start, start + e.compressedSize);
  if (data.size !== e.compressedSize) throw new ZipError("corrupt");
  // Stored entries are a slice of the archive: no copy in memory.
  if (e.method === 0) return data;
  if (e.method !== 8) throw new ZipError("unsupported");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflate = new Inflate((chunk) => {
    chunks.push(chunk);
    total += chunk.length;
  });
  try {
    // Read in slices (bounded memory; works where Blob.stream is missing).
    for (let at = 0; at < data.size; at += READ_CHUNK) {
      const chunk = new Uint8Array(await data.slice(at, at + READ_CHUNK).arrayBuffer());
      inflate.push(chunk, at + READ_CHUNK >= data.size);
    }
    if (data.size === 0) inflate.push(new Uint8Array(0), true);
  } catch (err) {
    if (err instanceof ZipError) throw err;
    throw new ZipError("corrupt");
  }
  if (total !== e.size) throw new ZipError("corrupt");
  return new Blob(chunks as BlobPart[]);
}

/**
 * Unpacks a zip in the browser (SPEC §28.1), one entry at a time, keeping the entries `keep`
 * accepts (by file name). Folders, `__MACOSX/` and dot files are always skipped. Returns the
 * kept files with their paths inside the archive and how many visible entries were not kept.
 * Rejects with a {@link ZipError}.
 */
export async function expandZip(
  zip: File,
  keep: (name: string) => boolean,
): Promise<{ files: ZipEntryFile[]; skipped: number }> {
  const entries = await readEntries(zip);
  const files: ZipEntryFile[] = [];
  let skipped = 0;
  for (const e of entries) {
    if (isHidden(e.name)) continue;
    const base = e.name.split("/").pop() ?? e.name;
    if (!keep(base)) {
      skipped++;
      continue;
    }
    const data = await entryData(zip, e);
    const file = new File([data], base, { lastModified: zip.lastModified });
    files.push(Object.assign(file, { path: e.name.replace(/^\/+/, "") }));
  }
  return { files, skipped };
}
