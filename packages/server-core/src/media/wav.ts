import fs from "node:fs/promises";
import { z } from "zod";

/**
 * WAV metadata preservation (SPEC §5.3 step 4, §5.6): all chunks except the audio data are stored
 * in order in a small `wavmeta` blob, so a downloaded WAV has the original header chunks
 * (fmt, bext, iXML, LIST, cue, smpl, …) byte-identical and in the original order.
 */

export interface WavChunk {
  id: string;
  /** Offset of the chunk header in the file. */
  offset: number;
  /** Payload size (without header and pad byte). */
  size: number;
}

export interface WavLayout {
  chunks: WavChunk[];
  fmt: WavFormat;
}

export interface WavFormat {
  formatTag: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Effective encoding of the data chunk. */
  encoding: "int" | "float" | "uint8";
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export class NotRiffWaveError extends Error {}

/**
 * Most header bytes (all chunks except `data`, with their 8-byte headers) kept as `wavmeta`.
 * Real BWF/iXML headers are a few kB; a crafted size field must not make ingest (or a later WAV
 * download, which reads the blob whole) allocate up to the upload size (SPEC §19.6).
 */
export const MAX_WAV_META_BYTES = 8 * 1024 * 1024;

/** The header chunks exceed {@link MAX_WAV_META_BYTES}; the file is ingested without `wavmeta`. */
export class WavMetaTooLargeError extends NotRiffWaveError {}

/** Reads the chunk layout without loading the audio data. */
export async function readWavLayout(file: string): Promise<WavLayout> {
  const fh = await fs.open(file, "r");
  try {
    const { size: fileSize } = await fh.stat();
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") {
      throw new NotRiffWaveError(
        "Not a RIFF/WAVE file (RF64 and others are not supported for wavmeta)",
      );
    }
    const chunks: WavChunk[] = [];
    let fmt: WavFormat | undefined;
    let metaBytes = 0;
    let pos = 12;
    const hdr = Buffer.alloc(8);
    while (pos + 8 <= fileSize) {
      await fh.read(hdr, 0, 8, pos);
      const id = hdr.toString("latin1", 0, 4);
      let size = hdr.readUInt32LE(4);
      // Some writers put a too-large size on the last chunk (data); clamp to the file.
      if (pos + 8 + size > fileSize) size = fileSize - pos - 8;
      if (id !== "data") {
        metaBytes += 8 + size + (size % 2);
        if (metaBytes > MAX_WAV_META_BYTES) {
          throw new WavMetaTooLargeError(
            `WAV header chunks exceed ${String(MAX_WAV_META_BYTES)} bytes`,
          );
        }
      }
      chunks.push({ id, offset: pos, size });
      if (id === "fmt ") {
        const b = Buffer.alloc(Math.min(size, 40));
        await fh.read(b, 0, b.length, pos + 8);
        fmt = parseFmt(b);
      }
      pos += 8 + size + (size % 2);
    }
    if (!fmt) throw new NotRiffWaveError("WAV has no fmt chunk");
    if (!chunks.some((c) => c.id === "data")) throw new NotRiffWaveError("WAV has no data chunk");
    return { chunks, fmt };
  } finally {
    await fh.close();
  }
}

function parseFmt(b: Buffer): WavFormat {
  let formatTag = b.readUInt16LE(0);
  const channels = b.readUInt16LE(2);
  const sampleRate = b.readUInt32LE(4);
  const bitsPerSample = b.readUInt16LE(14);
  if (formatTag === WAVE_FORMAT_EXTENSIBLE && b.length >= 26) formatTag = b.readUInt16LE(24); // SubFormat GUID
  const encoding =
    formatTag === WAVE_FORMAT_IEEE_FLOAT ? "float" : bitsPerSample === 8 ? "uint8" : "int";
  if (formatTag !== WAVE_FORMAT_PCM && formatTag !== WAVE_FORMAT_IEEE_FLOAT) {
    throw new NotRiffWaveError(`Unsupported WAV format tag ${formatTag}`);
  }
  return { formatTag, channels, sampleRate, bitsPerSample, encoding };
}

const MAGIC = Buffer.from("BRWM");

const WavMetaIndexSchema = z.object({
  version: z.literal(1),
  fmt: z.object({
    formatTag: z.number(),
    channels: z.number(),
    sampleRate: z.number(),
    bitsPerSample: z.number(),
    encoding: z.enum(["int", "float", "uint8"]),
  }),
  /** In original order; `data` marks where the audio goes. */
  chunks: z.array(
    z.union([
      z.object({ id: z.literal("data"), size: z.number() }),
      z.object({ id: z.string(), size: z.number(), blobOffset: z.number() }),
    ]),
  ),
});
export type WavMetaIndex = z.infer<typeof WavMetaIndexSchema>;

/**
 * Builds the `wavmeta` blob: "BRWM", u32 JSON length, JSON index, then the raw non-data chunks
 * (header + payload + pad byte) concatenated.
 */
export async function buildWavMeta(file: string): Promise<Buffer> {
  const layout = await readWavLayout(file);
  const fh = await fs.open(file, "r");
  try {
    const parts: Buffer[] = [];
    let blobOffset = 0;
    const entries: WavMetaIndex["chunks"] = [];
    for (const c of layout.chunks) {
      if (c.id === "data") {
        entries.push({ id: "data", size: c.size });
        continue;
      }
      const total = 8 + c.size + (c.size % 2);
      const buf = Buffer.alloc(total);
      await fh.read(buf, 0, total, c.offset);
      parts.push(buf);
      entries.push({ id: c.id, size: c.size, blobOffset });
      blobOffset += total;
    }
    const index: WavMetaIndex = { version: 1, fmt: layout.fmt, chunks: entries };
    const json = Buffer.from(JSON.stringify(index), "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(json.length);
    return Buffer.concat([MAGIC, len, json, ...parts]);
  } finally {
    await fh.close();
  }
}

export interface ParsedWavMeta {
  index: WavMetaIndex;
  /** Raw chunk bytes (the part after the JSON). */
  body: Buffer;
}

export function parseWavMeta(buf: Buffer): ParsedWavMeta {
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error("Not a wavmeta blob");
  const len = buf.readUInt32LE(4);
  const index = WavMetaIndexSchema.parse(JSON.parse(buf.subarray(8, 8 + len).toString("utf8")));
  return { index, body: buf.subarray(8 + len) };
}

export function wavDataSize(meta: ParsedWavMeta): number {
  const d = meta.index.chunks.find((c) => c.id === "data");
  if (!d) throw new Error("wavmeta has no data entry");
  return d.size;
}

/** Total file size of the reconstructed WAV (for Content-Length). */
export function reconstructedWavSize(meta: ParsedWavMeta): number {
  let riff = 4;
  for (const c of meta.index.chunks) riff += 8 + c.size + (c.size % 2);
  return 8 + riff;
}

/**
 * Yields the reconstructed WAV: RIFF header, the stored chunks in order, and at the `data`
 * position the PCM from `pcm` (exactly `size` bytes).
 */
export async function* reconstructWav(
  meta: ParsedWavMeta,
  pcm: AsyncIterable<Buffer>,
): AsyncGenerator<Buffer> {
  const riffHeader = Buffer.alloc(12);
  riffHeader.write("RIFF", 0, "ascii");
  riffHeader.writeUInt32LE(reconstructedWavSize(meta) - 8, 4);
  riffHeader.write("WAVE", 8, "ascii");
  yield riffHeader;
  for (const c of meta.index.chunks) {
    if ("blobOffset" in c) {
      yield meta.body.subarray(c.blobOffset, c.blobOffset + 8 + c.size + (c.size % 2));
      continue;
    }
    const h = Buffer.alloc(8);
    h.write("data", 0, "ascii");
    h.writeUInt32LE(c.size, 4);
    yield h;
    let remaining = c.size;
    for await (const chunk of pcm) {
      if (remaining <= 0) continue; // drain
      const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      remaining -= part.length;
      yield part;
    }
    if (remaining > 0) yield Buffer.alloc(remaining); // defensive: never emit a short data chunk
    if (c.size % 2) yield Buffer.alloc(1);
  }
}

/** ffmpeg raw output format matching the original WAV sample encoding. */
export function rawFormatFor(
  fmt: WavFormat["encoding"],
  bits: number,
): { format: string; codec: string } {
  if (fmt === "float")
    return bits === 64
      ? { format: "f64le", codec: "pcm_f64le" }
      : { format: "f32le", codec: "pcm_f32le" };
  if (fmt === "uint8") return { format: "u8", codec: "pcm_u8" };
  switch (bits) {
    case 16:
      return { format: "s16le", codec: "pcm_s16le" };
    case 24:
      return { format: "s24le", codec: "pcm_s24le" };
    case 32:
      return { format: "s32le", codec: "pcm_s32le" };
    default:
      throw new Error(`Unsupported WAV bit depth ${bits}`);
  }
}
