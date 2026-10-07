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

/** WAV header for lossless sources that were not WAV files (AIFF, FLAC, ALAC, …). */
function syntheticWavMeta(
  channels: number,
  sampleRate: number,
  bitDepth: number,
  frames: number,
): ParsedWavMeta {
  const fmt = Buffer.alloc(8 + 16);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  const bytes = bitDepth / 8;
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * bytes, 16);
  fmt.writeUInt16LE(channels * bytes, 20);
  fmt.writeUInt16LE(bitDepth, 22);
  return {
    index: {
      version: 1,
      fmt: { formatTag: 1, channels, sampleRate, bitsPerSample: bitDepth, encoding: "int" },
      chunks: [
        { id: "fmt ", size: 16, blobOffset: 0 },
        { id: "data", size: frames * channels * bytes },
      ],
    },
    body: fmt,
  };
}

/**
 * Sends a track version as original/FLAC/WAV/Opus (SPEC §5.6). WAV is the kept original when it
 * was a WAV, else rebuilt from the FLAC with the stored header. `logDownload` records the event.
 * A rebuild runs ffmpeg in the API, so it needs the process-wide slot (`ctx.ffmpegSlots`, SPEC
 * §19.6); while it is taken the request answers `RATE_LIMITED`.
 */
export async function sendVersionDownload(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  versionId: string,
  format: DownloadFormat,
  logDownload: (bytes: number | null) => void,
) {
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

  const direct = (variant: string, filename: string, type: string) => {
    const v = vars.get(variant);
    if (!v) throw new AppError("NOT_FOUND", `No ${format} available`);
    logDownload(getBlob(ctx.db, v.blobHash)?.sizeBytes ?? null);
    return sendBlob(ctx, request, reply, v.blobHash, type, contentDisposition(filename));
  };

  if (format === "original") return direct("original", asset.originalFilename, asset.mimeType);
  if (format === "flac") return direct("flac", `${base}.flac`, "audio/flac");
  if (format === "opus") return direct("opus", `${base}.opus`, "audio/ogg");

  // WAV: the kept original if it is a WAV, else streamed from the FLAC (SPEC §5.6).
  const wavName = /\.wav$/i.test(asset.originalFilename) ? asset.originalFilename : `${base}.wav`;
  if (vars.has("original") && probe && /wav/.test(probe.container)) {
    return direct("original", wavName, "audio/wav");
  }
  const flac = vars.get("flac");
  const flacBlob = flac && getBlob(ctx.db, flac.blobHash);
  if (!flac || !flacBlob || !probe) throw new AppError("NOT_FOUND", "No WAV available");
  const flacMeta = JSON.parse(flac.meta) as { channels?: number; bitDepth?: number };
  // ffmpeg runs in the API process: one rebuild at a time (SPEC §19.6), no queue.
  const release = ctx.ffmpegSlots.tryAcquire();
  if (!release) {
    throw new AppError("RATE_LIMITED", "Another WAV download is being prepared", {
      retryAfterSec: WAV_BUSY_RETRY_SEC,
    });
  }
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
    release();
  };
  // The response closes when it finished or the client went away: stop ffmpeg, free the slot.
  request.raw.once("close", () => {
    abort.abort();
  });
  reply.raw.once("close", stop);
  let meta: ParsedWavMeta;
  let flacPath: string;
  try {
    const wavmeta = vars.get("wavmeta");
    const wavmetaBlob = wavmeta && getBlob(ctx.db, wavmeta.blobHash);
    if (wavmetaBlob) {
      const chunks: Buffer[] = [];
      for await (const c of ctx.storage.getStream(wavmetaBlob.storageKey)) chunks.push(c as Buffer);
      meta = parseWavMeta(Buffer.concat(chunks));
    } else {
      meta = syntheticWavMeta(
        probe.channels,
        probe.sampleRate,
        flacMeta.bitDepth ?? 24,
        probe.durationSamples,
      );
    }
    flacPath = await ctx.storage.localPath(flacBlob.storageKey);
  } catch (err) {
    stop();
    throw err;
  }
  const { format: raw, codec } = rawFormatFor(
    meta.index.fmt.encoding,
    meta.index.fmt.bitsPerSample,
  );
  const expand = meta.index.fmt.channels === 2 && flacMeta.channels === 1; // dual-mono → stereo
  const pcm = new PassThrough();
  runTool(
    ctx.tools.ffmpeg,
    ffmpegArgs(
      "-i",
      flacPath,
      ...(expand ? ["-af", "pan=stereo|c0=c0|c1=c0"] : []),
      "-c:a",
      codec,
      "-f",
      raw,
      "-",
    ),
    {
      // `pcm` ends only when ffmpeg succeeded; a failure must not look like a short, zero-padded
      // but complete WAV (review M7).
      stdout: (out) => {
        out.pipe(pcm, { end: false });
        return finished(out);
      },
      signal: abort.signal,
    },
  )
    .then(
      () => pcm.end(),
      (err: unknown) => {
        if (!abort.signal.aborted) request.log.error({ err }, "wav reconstruction failed");
        pcm.destroy(err instanceof Error ? err : new Error(String(err)));
      },
    )
    .finally(release);
  const size = reconstructedWavSize(meta);
  // Logged only once the whole file was handed to the client.
  reply.raw.once("finish", () => {
    logDownload(size);
  });
  reply
    .header("Content-Type", "audio/wav")
    .header("Content-Length", size)
    .header("Content-Disposition", contentDisposition(path.basename(wavName)));
  return reply.send(Readable.from(reconstructWav(meta, pcm)));
}
