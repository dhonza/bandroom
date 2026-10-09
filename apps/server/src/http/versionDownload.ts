import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  assetProbe,
  ffmpegArgs,
  getAsset,
  getBlob,
  getTrackVersionRow,
  listVariants,
  parseWavMeta,
  rawFormatFor,
  reconstructedWavSize,
  reconstructWav,
  runTool,
  type ParsedWavMeta,
} from "@bandroom/server-core";
import type { DownloadFormat } from "@bandroom/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { contentDisposition, sendBlob } from "./blobs";
import { AppError } from "./errors";

/** Retry hint while the WAV rebuild slot is busy. */
const WAV_BUSY_RETRY_SEC = 5;

/**
 * WAV header for lossless sources that were not WAV files (AIFF, FLAC, ALAC, …); `float` for a
 * 32-bit float source rebuilt from its WavPack.
 */
function syntheticWavMeta(
  channels: number,
  sampleRate: number,
  bitDepth: number,
  frames: number,
  float = false,
): ParsedWavMeta {
  const fmt = Buffer.alloc(8 + 16);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  const bytes = bitDepth / 8;
  const formatTag = float ? 3 : 1;
  fmt.writeUInt16LE(formatTag, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * bytes, 16);
  fmt.writeUInt16LE(channels * bytes, 20);
  fmt.writeUInt16LE(bitDepth, 22);
  return {
    index: {
      version: 1,
      fmt: {
        formatTag,
        channels,
        sampleRate,
        bitsPerSample: bitDepth,
        encoding: float ? "float" : "int",
      },
      chunks: [
        { id: "fmt ", size: 16, blobOffset: 0 },
        { id: "data", size: frames * channels * bytes },
      ],
    },
    body: fmt,
  };
}

/** A version's file in one format, ready to stream (SPEC §5.6). */
export type DownloadSource =
  | {
      kind: "blob";
      hash: string;
      storageKey: string;
      size: number;
      filename: string;
      contentType: string;
    }
  | {
      /** A WAV rebuilt from the FLAC or WavPack with ffmpeg (needs `ctx.ffmpegSlots`). */
      kind: "wav";
      size: number;
      filename: string;
      meta: ParsedWavMeta;
      /** The FLAC, or the WavPack of a float source. */
      srcPath: string;
      /** Dual-mono FLAC expanded back to stereo. */
      expand: boolean;
    };

/**
 * Resolves a track version to its file in `format`: original/FLAC/WavPack/Opus are stored blobs;
 * WAV is the kept original when it was a WAV, else rebuilt with the stored header from the WavPack
 * (float sources, exact) or the FLAC.
 */
export async function resolveDownload(
  ctx: AppContext,
  versionId: string,
  format: DownloadFormat,
): Promise<DownloadSource> {
  const version = getTrackVersionRow(ctx.db, versionId);
  const asset = version && getAsset(ctx.db, version.assetId);
  if (!version || !asset || asset.status !== "ready")
    throw new AppError("NOT_FOUND", "Version not available");
  // Full quality removed (SPEC §26.4): only Opus is left.
  if (version.archivedAt !== null && format !== "opus")
    throw new AppError("LOSSLESS_REMOVED", "Full-quality files were removed");
  const vars = new Map(listVariants(ctx.db, asset.id).map((v) => [v.variant, v]));
  const probe = assetProbe(asset);
  const base = asset.originalFilename.replace(/\.[^.]+$/, "") || "audio";

  const direct = (variant: string, filename: string, contentType: string): DownloadSource => {
    const v = vars.get(variant);
    const blob = v && getBlob(ctx.db, v.blobHash);
    if (!v || !blob) throw new AppError("NOT_FOUND", `No ${format} available`);
    return {
      kind: "blob",
      hash: v.blobHash,
      storageKey: blob.storageKey,
      size: blob.sizeBytes,
      filename,
      contentType,
    };
  };

  if (format === "original") return direct("original", asset.originalFilename, asset.mimeType);
  if (format === "flac") return direct("flac", `${base}.flac`, "audio/flac");
  if (format === "opus") return direct("opus", `${base}.opus`, "audio/ogg");
  if (format === "wavpack") return direct("wavpack", `${base}.wv`, "audio/wavpack");

  // WAV: the kept original if it is a WAV, else streamed from the WavPack or FLAC (SPEC §5.6).
  const wavName = /\.wav$/i.test(asset.originalFilename) ? asset.originalFilename : `${base}.wav`;
  if (vars.has("original") && probe && /wav/.test(probe.container)) {
    return direct("original", wavName, "audio/wav");
  }
  // A float source's exact copy is the WavPack; its FLAC is only near-lossless 24-bit.
  const source = vars.get("wavpack") ?? vars.get("flac");
  const sourceBlob = source && getBlob(ctx.db, source.blobHash);
  if (!source || !sourceBlob || !probe) throw new AppError("NOT_FOUND", "No WAV available");
  const float = source.variant === "wavpack";
  const sourceMeta = JSON.parse(source.meta) as { channels?: number; bitDepth?: number };
  const wavmeta = vars.get("wavmeta");
  const wavmetaBlob = wavmeta && getBlob(ctx.db, wavmeta.blobHash);
  let meta: ParsedWavMeta;
  if (wavmetaBlob) {
    const chunks: Buffer[] = [];
    for await (const c of ctx.storage.getStream(wavmetaBlob.storageKey)) chunks.push(c as Buffer);
    meta = parseWavMeta(Buffer.concat(chunks));
  } else {
    meta = syntheticWavMeta(
      probe.channels,
      probe.sampleRate,
      float ? 32 : (sourceMeta.bitDepth ?? 24),
      probe.durationSamples,
      float,
    );
  }
  return {
    kind: "wav",
    size: reconstructedWavSize(meta),
    filename: path.basename(wavName),
    meta,
    srcPath: await ctx.storage.localPath(sourceBlob.storageKey),
    expand: meta.index.fmt.channels === 2 && sourceMeta.channels === 1,
  };
}

/**
 * Streams a rebuilt WAV: ffmpeg decodes the FLAC or WavPack to raw PCM, the stored header and chunks go
 * around it. The caller holds the ffmpeg slot (SPEC §19.6); `signal` stops ffmpeg. A failed
 * decode errors the stream (never a short, zero-padded WAV).
 */
export function streamWav(
  ctx: AppContext,
  src: Extract<DownloadSource, { kind: "wav" }>,
  signal: AbortSignal,
  log: FastifyRequest["log"],
): { stream: AsyncIterable<Buffer>; done: Promise<void> } {
  const { format: raw, codec } = rawFormatFor(
    src.meta.index.fmt.encoding,
    src.meta.index.fmt.bitsPerSample,
  );
  const pcm = new PassThrough();
  const done = runTool(
    ctx.tools.ffmpeg,
    ffmpegArgs(
      "-i",
      src.srcPath,
      ...(src.expand ? ["-af", "pan=stereo|c0=c0|c1=c0"] : []),
      "-c:a",
      codec,
      "-f",
      raw,
      "-",
    ),
    {
      // `pcm` ends only when ffmpeg succeeded (review M7).
      stdout: (out) => {
        out.pipe(pcm, { end: false });
        return finished(out);
      },
      signal,
    },
  ).then(
    () => {
      pcm.end();
    },
    (err: unknown) => {
      if (!signal.aborted) log.error({ err }, "wav reconstruction failed");
      pcm.destroy(err instanceof Error ? err : new Error(String(err)));
    },
  );
  return { stream: reconstructWav(src.meta, pcm), done };
}

/** Takes the API's single ffmpeg slot, or answers `RATE_LIMITED` (no queue). */
export function acquireFfmpegSlot(ctx: AppContext, message: string): () => void {
  const release = ctx.ffmpegSlots.tryAcquire();
  if (!release) throw new AppError("RATE_LIMITED", message, { retryAfterSec: WAV_BUSY_RETRY_SEC });
  return release;
}

/**
 * Sends a track version as original/FLAC/WAV/WavPack/Opus (SPEC §5.6). `logDownload` records the event.
 * A WAV rebuild runs ffmpeg in the API, so it needs the process-wide slot (`ctx.ffmpegSlots`,
 * SPEC §19.6); while it is taken the request answers `RATE_LIMITED`.
 */
export async function sendVersionDownload(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  versionId: string,
  format: DownloadFormat,
  logDownload: (bytes: number | null) => void,
) {
  const src = await resolveDownload(ctx, versionId, format);
  if (src.kind === "blob") {
    logDownload(src.size);
    return sendBlob(
      ctx,
      request,
      reply,
      src.hash,
      src.contentType,
      contentDisposition(src.filename),
    );
  }
  const release = acquireFfmpegSlot(ctx, "Another WAV download is being prepared");
  const abort = new AbortController();
  // The response closes when it finished or the client went away: stop ffmpeg, free the slot.
  request.raw.once("close", () => {
    abort.abort();
  });
  reply.raw.once("close", () => {
    abort.abort();
    release();
  });
  const { stream, done } = streamWav(ctx, src, abort.signal, request.log);
  void done.finally(release);
  // Logged only once the whole file was handed to the client.
  reply.raw.once("finish", () => {
    logDownload(src.size);
  });
  reply
    .header("Content-Type", "audio/wav")
    .header("Content-Length", src.size)
    .header("Content-Disposition", contentDisposition(src.filename));
  return reply.send(Readable.from(stream));
}
