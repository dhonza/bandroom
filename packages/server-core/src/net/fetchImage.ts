import { Readable } from "node:stream";
import { safeFetch, SafeFetchError, type SafeFetchOptions } from "./safeFetch";

/** Image types a fetched URL may be (SPEC §25.4); judged by the first bytes, not the header. */
export const FETCHABLE_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;
export type FetchableImageType = (typeof FETCHABLE_IMAGE_TYPES)[number];

const ascii = (head: Buffer, at: number, len: number) =>
  head.subarray(at, at + len).toString("latin1");

/** The image type from the first bytes, or null when it is not one of the accepted types. */
export function sniffImageType(head: Buffer): FetchableImageType | null {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return "image/webp";
  if (ascii(head, 4, 4) === "ftyp") {
    // ISO BMFF: major brand avif/avis, or avif among the compatible brands of the ftyp box.
    const boxSize = head.readUInt32BE(0);
    const end = Math.min(boxSize, head.length);
    for (let at = 8; at + 4 <= end; at += 4) {
      if (at === 12) continue; // minor version
      const brand = ascii(head, at, 4);
      if (brand === "avif" || brand === "avis") return "image/avif";
    }
  }
  return null;
}

/** Bytes kept back to sniff the type (covers an ftyp box with a few compatible brands). */
const SNIFF_BYTES = 64;

/** Reads at least `n` bytes (or all there is) and returns them plus a stream of everything. */
async function peek(body: Readable, n: number): Promise<{ head: Buffer; stream: Readable }> {
  const it = body[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const chunks: Buffer[] = [];
  let length = 0;
  let ended = false;
  while (length < n) {
    const next = await it.next();
    if (next.done) {
      ended = true;
      break;
    }
    chunks.push(next.value);
    length += next.value.length;
  }
  const head = Buffer.concat(chunks);
  async function* all(): AsyncGenerator<Buffer> {
    yield head;
    if (ended) return;
    for (;;) {
      const next = await it.next();
      if (next.done) return;
      yield next.value;
    }
  }
  const stream = Readable.from(all(), { objectMode: false });
  // Ending early (client gone) releases the source.
  stream.once("close", () => {
    if (!body.destroyed) body.destroy();
  });
  return { head, stream };
}

export interface FetchedImage {
  mime: FetchableImageType;
  /** From Content-Length, when the server sent it. */
  contentLength: number | null;
  /** The image bytes, streamed and capped; errors with a {@link SafeFetchError}. */
  stream: Readable;
}

/**
 * Fetches an image from a user-given URL for the crop dialog (SPEC §25.4). The answer must say
 * `image/*` and start like a PNG, JPEG, GIF, WebP or AVIF file; anything else fails with
 * `NOT_IMAGE`. Nothing is stored: the caller streams the bytes on.
 */
export async function fetchImage(
  url: string,
  options: Omit<SafeFetchOptions, "headers">,
): Promise<FetchedImage> {
  const res = await safeFetch(url, {
    ...options,
    headers: {
      accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,image/*;q=0.8",
      "user-agent": "BandRoom (image fetch)",
    },
  });
  const type = (res.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!type.startsWith("image/")) {
    res.abort();
    throw new SafeFetchError("NOT_IMAGE", `Content-Type ${type || "(none)"}`);
  }
  try {
    const { head, stream } = await peek(res.body, SNIFF_BYTES);
    const mime = sniffImageType(head);
    if (!mime) {
      stream.destroy();
      res.abort();
      throw new SafeFetchError("NOT_IMAGE", "Not a supported image");
    }
    return { mime, contentLength: res.contentLength, stream };
  } catch (err) {
    res.abort();
    throw err;
  }
}
