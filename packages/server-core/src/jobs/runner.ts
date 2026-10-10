import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { editAssetSettled } from "../content/editRenders";
import type { Db } from "../db/connection";
import { DEFAULT_TOOLS, ToolTimeoutError, type ToolPaths } from "../media/tools";
import { getVariant, putVariant } from "../media/variants";
import { getBlob, storeFile } from "../storage/blobs";
import type { StorageBackend } from "../storage/backend";
import { completeJob, failJob, heartbeatJob, requeueInterruptedJob, type JobRow } from "./queue";
import { settleFailedJob } from "./settle";
import { PermanentJobError, type JobContext, type JobEvent, type JobHandler } from "./types";

export interface RunnerDeps {
  db: Db;
  storage: StorageBackend;
  tools?: ToolPaths;
  workerId: string;
  /** Parent for per-job temp dirs (default: OS temp). Should be on the data volume. */
  tmpRoot?: string;
  emit?: (event: JobEvent) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  heartbeatMs?: number;
  /** Aborts the running job (e.g. worker shutdown); the job is retried later. */
  signal?: AbortSignal;
}

export type HandlerRegistry = ReadonlyMap<string, JobHandler>;

// `run` is declared with method syntax, so handlers with specific payload types are assignable.
export function handlerRegistry(handlers: readonly JobHandler[]): HandlerRegistry {
  return new Map(handlers.map((h) => [h.type, h]));
}

/** Asset whose status a job drives (for marking it failed on permanent errors). */
function assetIdOf(payload: unknown): string | null {
  return typeof payload === "object" &&
    payload !== null &&
    "assetId" in payload &&
    typeof payload.assetId === "string"
    ? payload.assetId
    : null;
}

/**
 * Removes per-job temp dirs (`job-*`) left in `root` by a process that died mid-job (SIGKILL,
 * OOM). Call it at startup, before this process claims jobs: `root` must be private to it.
 * Returns how many entries were removed.
 */
export async function sweepJobTmp(root: string): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith("job-")) continue;
    await fs.rm(path.join(root, name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/**
 * Runs one claimed job to completion: validates the payload, provides the {@link JobContext},
 * renews the lease while running, and records success, retry or failure (SPEC §18.4).
 */
export async function executeJob(
  deps: RunnerDeps,
  handlers: HandlerRegistry,
  job: JobRow,
): Promise<"done" | "queued" | "failed"> {
  const { db, storage, workerId } = deps;
  const log = deps.log ?? (() => undefined);
  const emit = deps.emit ?? (() => undefined);
  const handler = handlers.get(job.type);
  const tmpDir = await fs.mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), `job-${job.id}-`));
  const controller = new AbortController();
  // Removed in `finally`: the worker's shutdown signal outlives every job (one listener per job
  // would otherwise pile up).
  const onShutdown = () => {
    controller.abort();
  };
  if (deps.signal?.aborted) controller.abort();
  else deps.signal?.addEventListener("abort", onShutdown, { once: true });
  let lastProgress: number | null = null;
  const heartbeat = setInterval(() => {
    // A failed heartbeat means the job was cancelled or taken over: stop working on it.
    if (!heartbeatJob(db, job.id, workerId, lastProgress)) controller.abort();
  }, deps.heartbeatMs ?? 15_000);

  let payload: unknown = null;
  try {
    if (!handler) throw new PermanentJobError(`No handler for job type ${job.type}`);
    payload = handler.payloadSchema.parse(JSON.parse(job.payload));
    const scope = payload as {
      projectId?: string | null;
      songId?: string | null;
      trackVersionId?: string | null;
    };
    const ctx: JobContext = {
      jobId: job.id,
      db,
      storage,
      tools: deps.tools ?? DEFAULT_TOOLS,
      tmpDir,
      signal: controller.signal,
      async input(ref) {
        const v = getVariant(db, ref.assetId, ref.variant);
        const blob = v && getBlob(db, v.blobHash);
        if (!blob) throw new Error(`Variant ${ref.variant} of ${ref.assetId} not found`);
        return storage.localPath(blob.storageKey);
      },
      async output(ref, filePath, meta = {}) {
        const blob = await storeFile(db, storage, filePath);
        putVariant(db, ref.assetId, ref.variant, blob.hash, meta);
        return blob.hash;
      },
      progress(fraction, note) {
        lastProgress = fraction;
        heartbeatJob(db, job.id, workerId, fraction);
        emit({
          type: "job.progress",
          projectId: scope.projectId ?? null,
          songId: scope.songId ?? null,
          data: {
            jobId: job.id,
            type: job.type,
            assetId: assetIdOf(payload),
            trackVersionId: scope.trackVersionId ?? null,
            progress: fraction,
            note: note ?? null,
          },
        });
      },
      log(msg) {
        log(msg, { jobId: job.id, type: job.type });
      },
      emit,
    };
    const result = await handler.run(ctx, payload);
    // A job cancelled while it ran is not "done": no asset.ready for it.
    if (!completeJob(db, job.id, result)) return "failed";
    const assetId = assetIdOf(payload);
    // A rendered edit's file is ready: its session may commit now (SPEC §24.10).
    if (assetId) editAssetSettled(db, assetId);
    emit({
      type: "asset.ready",
      projectId: scope.projectId ?? null,
      songId: scope.songId ?? null,
      data: { jobId: job.id, assetId, trackVersionId: scope.trackVersionId ?? null },
    });
    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Interrupted by our own shutdown: not the job's fault, so it keeps its attempt.
    if (deps.signal?.aborted && requeueInterruptedJob(db, job.id, workerId)) {
      log("job interrupted by shutdown; re-queued", { jobId: job.id, type: job.type });
      return "queued";
    }
    const permanent =
      err instanceof PermanentJobError ||
      err instanceof SyntaxError ||
      // A tool that ran past its job's generous limit would hang again on a retry.
      err instanceof ToolTimeoutError ||
      (err as { name?: string }).name === "ZodError";
    const status = failJob(db, job.id, message, { permanent });
    log(`job failed: ${message}`, { jobId: job.id, type: job.type, status });
    if (status === "failed") for (const e of settleFailedJob(db, job, message).events) emit(e);
    return status === "queued" ? "queued" : "failed";
  } finally {
    deps.signal?.removeEventListener("abort", onShutdown);
    clearInterval(heartbeat);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
