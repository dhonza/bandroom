import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { Db } from "../db/connection";
import { claimJob, enqueueJob } from "../jobs/queue";
import { executeJob, handlerRegistry } from "../jobs/runner";
import type { JobEvent } from "../jobs/types";
import { createAsset } from "../media/assets";
import { documentIngestHandler } from "../media/document";
import { imageIngestHandler } from "../media/image";
import { audioIngestHandler } from "../media/ingest";
import { audioReencodeHandler } from "../media/reencode";
import { DEFAULT_TOOLS, ffmpegArgs, runTool, type ToolPaths } from "../media/tools";
import { getVariant, putVariant } from "../media/variants";
import { getBlob, storeFile } from "../storage/blobs";
import { LocalStorage } from "../storage/local";

export const HANDLERS = handlerRegistry([
  audioIngestHandler,
  audioReencodeHandler,
  imageIngestHandler,
  documentIngestHandler,
]);

export interface Harness {
  db: Db;
  storage: LocalStorage;
  root: string;
  events: JobEvent[];
}

export function createHarness(db: Db, root: string): Harness {
  return { db, storage: new LocalStorage(path.join(root, "blobs")), root, events: [] };
}

/** Uploads a local file as an asset's `original` (copy, since storage moves files). */
export async function addOriginal(
  h: Harness,
  file: string,
  uploadedBy: string | null = null,
  kind: "audio" | "image" | "document" = "audio",
) {
  const tmp = path.join(h.root, `in-${path.basename(file)}-${Date.now()}-${Math.random()}`);
  await fs.copyFile(file, tmp);
  const { size } = await fs.stat(tmp);
  const blob = await storeFile(h.db, h.storage, tmp);
  const asset = createAsset(h.db, {
    kind,
    originalFilename: path.basename(file),
    sizeBytes: size,
    originalHash: blob.hash,
    uploadedBy,
  });
  putVariant(h.db, asset.id, "original", blob.hash, { size });
  return asset;
}

export async function runOneJob(h: Harness, type: string, payload: unknown, tools?: ToolPaths) {
  enqueueJob(h.db, { type, capability: type, payload });
  const job = claimJob(h.db, "test-worker", [type]);
  if (!job) throw new Error("no job claimed");
  const status = await executeJob(
    {
      db: h.db,
      storage: h.storage,
      workerId: "test-worker",
      tmpRoot: h.root,
      ...(tools ? { tools } : {}),
      emit: (e) => h.events.push(e),
    },
    HANDLERS,
    job,
  );
  return { job, status };
}

export async function variantPath(h: Harness, assetId: string, variant: string): Promise<string> {
  const v = getVariant(h.db, assetId, variant);
  const blob = v && getBlob(h.db, v.blobHash);
  if (!blob) throw new Error(`no ${variant}`);
  return h.storage.localPath(blob.storageKey);
}

/** Decodes the first channel of a file to float samples (optionally resampled). */
export async function decodeMono(file: string, sampleRate?: number): Promise<Float32Array> {
  const chunks: Buffer[] = [];
  await runTool(
    DEFAULT_TOOLS.ffmpeg,
    ffmpegArgs(
      "-i",
      file,
      "-map",
      "0:a:0",
      "-af",
      "pan=mono|c0=c0",
      ...(sampleRate ? ["-ar", String(sampleRate)] : []),
      "-f",
      "f32le",
      "-",
    ),
    {
      stdout: async (s: Readable) => {
        for await (const c of s) chunks.push(c as Buffer);
      },
    },
  );
  const buf = Buffer.concat(chunks);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

/** Position of the largest |sample| within ±window of `expected`. */
export function peakNear(samples: Float32Array, expected: number, window = 2000): number {
  let best = -1;
  let bestAbs = -1;
  for (
    let i = Math.max(0, expected - window);
    i < Math.min(samples.length, expected + window);
    i++
  ) {
    const a = Math.abs(samples[i] ?? 0);
    if (a > bestAbs) {
      bestAbs = a;
      best = i;
    }
  }
  return best;
}

/**
 * Timing offset of `test` relative to `ref` around `center`: the lag in [-maxLag, maxLag] that
 * maximizes their cross-correlation over ±window samples. Robust against codec smearing of a
 * single-sample impulse, where the loudest sample is not a reliable timing marker.
 */
export function correlationLag(
  ref: Float32Array,
  test: Float32Array,
  center: number,
  maxLag = 20,
  window = 512,
): number {
  let bestLag = 0;
  let best = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = center - window; i <= center + window; i++) {
      sum += (ref[i] ?? 0) * (test[i + lag] ?? 0);
    }
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return bestLag;
}
