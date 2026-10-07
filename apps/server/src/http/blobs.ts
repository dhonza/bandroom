import { getBlob } from "@bandroom/server-core";
import { parseRange } from "@bandroom/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { BoundedRecent } from "./boundedRecent";
import { AppError } from "./errors";

export const CONTENT_TYPES: Record<string, string> = {
  opus: "audio/ogg",
  opus_low: "audio/ogg",
  flac: "audio/flac",
  peaks: "application/octet-stream",
  seekindex_opus: "application/json",
  seekindex_opus_low: "application/json",
  seekindex_flac: "application/json",
  webp_256: "image/webp",
  webp_512: "image/webp",
  webp_1024: "image/webp",
  webp_2048: "image/webp",
  webp_logo: "image/webp",
};

const ACCESS_CACHE_MS = 5 * 60_000;
const ACCESS_CACHE_MAX = 5000;

/** Per-session cache of blob access decisions (SPEC §18.3: cached for 5 minutes, bounded). */
export class AccessCache {
  private readonly recent = new BoundedRecent(ACCESS_CACHE_MS, ACCESS_CACHE_MAX);
  has(key: string, now: number): boolean {
    return this.recent.isRecent(key, now);
  }
  add(key: string, now: number): void {
    this.recent.mark(key, now);
  }
}

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Streams a blob with ETag (= hash) and single-range support. `cacheControl` defaults to
 * immutable caching; document content uses `no-cache` so every view reaches the server.
 */
export async function sendBlob(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  hash: string,
  contentType: string,
  disposition?: string,
  cacheControl = "private, max-age=31536000, immutable",
) {
  const blob = getBlob(ctx.db, hash);
  if (!blob) throw new AppError("NOT_FOUND", "Blob not found");
  const etag = `"${hash}"`;
  reply
    .header("ETag", etag)
    .header("Accept-Ranges", "bytes")
    .header("Cache-Control", cacheControl)
    .header("Content-Type", contentType);
  if (disposition) reply.header("Content-Disposition", disposition);
  if (request.headers["if-none-match"] === etag) return reply.status(304).send();
  const range = parseRange(request.headers.range, blob.sizeBytes);
  if (range === "invalid") {
    return reply.status(416).header("Content-Range", `bytes */${blob.sizeBytes}`).send();
  }
  if (range) {
    reply
      .status(206)
      .header("Content-Range", `bytes ${range.start}-${range.end}/${blob.sizeBytes}`)
      .header("Content-Length", range.end - range.start + 1);
    return reply.send(ctx.storage.getStream(blob.storageKey, range));
  }
  reply.header("Content-Length", blob.sizeBytes);
  return reply.send(request.method === "HEAD" ? "" : ctx.storage.getStream(blob.storageKey));
}

/** Per-client limit of the download routes (logged-in and link). */
export const DOWNLOAD_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const;
