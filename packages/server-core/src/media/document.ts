import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { documentKindFromName, type DocumentKind, type DocumentProbe } from "@bandroom/shared";
import { eq } from "drizzle-orm";
import sharp, { type Metadata } from "sharp";
import { z } from "zod";
import { getDocumentRow, updateDocumentRow } from "../content/documents";
import { assets } from "../db/schema";
import type { Db } from "../db/connection";
import { PermanentJobError, type JobHandler } from "../jobs/types";
import { getAsset, setAssetStatus } from "./assets";
import { runTool } from "./tools";

// libvips: one thread, no operation cache (SPEC §19.6, 1 GB RAM target).
sharp.concurrency(1);
sharp.cache(false);

const LIMIT_PIXELS = 64_000_000;
/** Poppler must not hang the only worker slot on a hostile PDF. */
const PDF_TOOL_TIMEOUT_MS = 60_000;
/** Text files above this size are stored but not rendered (see DOCUMENT_TEXT_VIEW_MAX_BYTES). */
const TEXT_SCAN_MAX_BYTES = 16 * 1024 * 1024;

export const DocumentIngestPayloadSchema = z.object({
  assetId: z.string(),
  documentId: z.string(),
  documentVersionId: z.string(),
  projectId: z.string().nullable().default(null),
  songId: z.string().nullable().default(null),
});
export type DocumentIngestPayload = z.infer<typeof DocumentIngestPayloadSchema>;

const MIME: Record<DocumentKind, string> = {
  markdown: "text/markdown",
  text: "text/plain",
  pdf: "application/pdf",
  image: "application/octet-stream",
  midi: "audio/midi",
  other: "application/octet-stream",
};

function startsWith(head: Buffer, bytes: readonly number[], at = 0): boolean {
  return bytes.every((b, i) => head[at + i] === b);
}

function ascii(head: Buffer, at: number, len: number): string {
  return head.subarray(at, at + len).toString("latin1");
}

/**
 * Document kind from the first bytes of the file (SPEC §5.2: content, not the extension alone).
 * Returns `null` for "no known binary signature": the caller then checks whether the file is
 * UTF-8 text, and the file name decides between Markdown and plain text.
 */
export function sniffDocument(head: Buffer): { kind: DocumentKind; mime: string } | null {
  if (ascii(head, 0, 5) === "%PDF-") return { kind: "pdf", mime: "application/pdf" };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return { kind: "image", mime: "image/png" };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
  if (ascii(head, 0, 4) === "GIF8") return { kind: "image", mime: "image/gif" };
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP")
    return { kind: "image", mime: "image/webp" };
  if (ascii(head, 4, 4) === "ftyp") {
    const brand = ascii(head, 8, 4);
    if (["heic", "heix", "mif1", "msf1", "heif"].includes(brand))
      return { kind: "image", mime: "image/heic" };
    if (brand === "avif") return { kind: "image", mime: "image/avif" };
    return { kind: "other", mime: "application/octet-stream" }; // MP4/M4A etc.
  }
  if (ascii(head, 0, 4) === "MThd") return { kind: "midi", mime: "audio/midi" };
  // ZIP (docx, xlsx, …), OLE (doc, xls), gzip, 7z, RAR, Ogg, FLAC, RIFF/WAVE, ID3 …
  const binary: readonly (readonly number[])[] = [
    [0x50, 0x4b, 0x03, 0x04],
    [0xd0, 0xcf, 0x11, 0xe0],
    [0x1f, 0x8b],
    [0x37, 0x7a, 0xbc, 0xaf],
    [0x52, 0x61, 0x72, 0x21],
  ];
  if (binary.some((b) => startsWith(head, b)))
    return { kind: "other", mime: "application/octet-stream" };
  if (
    ["OggS", "fLaC", "RIFF", "FORM", "ID3\u0003", "ID3\u0004", "wvpk"].includes(ascii(head, 0, 4))
  )
    return { kind: "other", mime: "application/octet-stream" };
  return null;
}

/** Whether a file is valid UTF-8 without NUL bytes (streamed, SPEC §5.7 "UTF-8 validated"). */
export async function isUtf8TextFile(file: string): Promise<boolean> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let seen = 0;
  try {
    for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
      const buf = chunk as Buffer;
      if (buf.includes(0)) return false;
      decoder.decode(buf, { stream: true });
      seen += buf.length;
      if (seen >= TEXT_SCAN_MAX_BYTES) return true; // large: stored, offered as a download
    }
    decoder.decode();
    return true;
  } catch {
    return false;
  }
}

async function readHead(file: string, n = 64): Promise<Buffer> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function withTimeout(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(PDF_TOOL_TIMEOUT_MS)]);
}

/**
 * `document.ingest` (SPEC §5.7): detects the kind by content; PDFs get a page count and a
 * first-page thumbnail (pdftoppm, 256 px), images WebP renditions (256 px thumbnail and a
 * ≤ 2048 px view, EXIF stripped, not cropped), text is UTF-8 validated and stored as-is. A PDF or
 * image that cannot be previewed is still stored and downloadable (a note explains why).
 */
export const documentIngestHandler: JobHandler<DocumentIngestPayload, DocumentProbe> = {
  type: "document.ingest",
  capability: "document.ingest",
  payloadSchema: DocumentIngestPayloadSchema,
  async run(ctx, payload) {
    const asset = getAsset(ctx.db, payload.assetId);
    if (!asset) throw new PermanentJobError("Asset not found");
    setAssetStatus(ctx.db, payload.assetId, "processing");
    const src = await ctx.input({ assetId: payload.assetId, variant: "original" });
    const byName = documentKindFromName(asset.originalFilename);
    const sniffed = sniffDocument(await readHead(src));
    let probe: DocumentProbe;
    let mime: string;
    if (sniffed) {
      probe = { kind: sniffed.kind };
      mime = sniffed.mime;
    } else if (await isUtf8TextFile(src)) {
      probe = { kind: byName === "markdown" ? "markdown" : "text" };
      mime = MIME[probe.kind];
    } else {
      probe = { kind: "other", note: "not UTF-8 text" };
      mime = MIME.other;
    }
    ctx.progress(0.2);

    if (probe.kind === "pdf") probe = await pdfPreview(ctx, payload.assetId, src, probe);
    else if (probe.kind === "image") probe = await imagePreview(ctx, payload.assetId, src, probe);

    ctx.db
      .update(assets)
      .set({ probe: JSON.stringify(probe), mimeType: mime })
      .where(eq(assets.id, payload.assetId))
      .run();
    syncDocumentKind(ctx.db, payload.documentId, payload.documentVersionId, probe.kind);
    setAssetStatus(ctx.db, payload.assetId, "ready");
    return probe;
  },
};

/** The document's kind follows its current version. */
export function syncDocumentKind(
  db: Db,
  documentId: string,
  versionId: string,
  kind: DocumentKind,
): void {
  const doc = getDocumentRow(db, documentId);
  if (doc && doc.currentVersionId === versionId && doc.kind !== kind) {
    updateDocumentRow(db, documentId, { kind });
  }
}

type Ctx = Parameters<JobHandler["run"]>[0];

async function pdfPreview(
  ctx: Ctx,
  assetId: string,
  src: string,
  probe: DocumentProbe,
): Promise<DocumentProbe> {
  const out: DocumentProbe = { ...probe, pages: null };
  try {
    const info = await runTool(ctx.tools.pdfinfo, [src], {
      captureStdout: true,
      signal: withTimeout(ctx.signal),
    });
    const m = /^Pages:\s+(\d+)/m.exec(info.stdout);
    out.pages = m ? Number(m[1]) : null;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.log(`pdfinfo failed: ${String(err)}`);
  }
  ctx.progress(0.5);
  try {
    const prefix = path.join(ctx.tmpDir, "page1");
    await runTool(
      ctx.tools.pdftoppm,
      ["-png", "-f", "1", "-l", "1", "-singlefile", "-scale-to", "256", src, prefix],
      { signal: withTimeout(ctx.signal) },
    );
    const thumb = path.join(ctx.tmpDir, "thumb-256.webp");
    const info = await sharp(`${prefix}.png`, { limitInputPixels: LIMIT_PIXELS })
      .webp({ quality: 80 })
      .toFile(thumb);
    await ctx.output({ assetId, variant: "webp_256" }, thumb, {
      width: info.width,
      height: info.height,
      format: "webp",
    });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.log(`pdf thumbnail failed: ${String(err)}`);
    out.note = "no thumbnail (unreadable or protected PDF)";
  }
  return out;
}

async function imagePreview(
  ctx: Ctx,
  assetId: string,
  src: string,
  probe: DocumentProbe,
): Promise<DocumentProbe> {
  let meta: Metadata;
  try {
    meta = await sharp(src, { limitInputPixels: LIMIT_PIXELS }).metadata();
  } catch {
    // e.g. HEIC without a decoder in the prebuilt libvips: stored and downloadable only.
    return { kind: "other", note: "image format without preview" };
  }
  if (!meta.width || !meta.height) return { kind: "other", note: "image without dimensions" };
  for (const [i, size] of [256, 2048].entries()) {
    const file = path.join(ctx.tmpDir, `doc-${size}.webp`);
    // .rotate() applies EXIF orientation; metadata is dropped by default.
    const info = await sharp(src, { limitInputPixels: LIMIT_PIXELS })
      .rotate()
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: size > 256 ? 85 : 80 })
      .toFile(file);
    await ctx.output({ assetId, variant: `webp_${size}` }, file, {
      width: info.width,
      height: info.height,
      format: "webp",
    });
    ctx.progress(0.5 + 0.25 * (i + 1));
  }
  return { ...probe, width: meta.width, height: meta.height };
}
