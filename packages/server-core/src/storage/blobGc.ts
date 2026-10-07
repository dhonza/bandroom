import { z } from "zod";
import type { Db } from "../db/connection";
import { enqueueJob } from "../jobs/queue";
import type { JobHandler } from "../jobs/types";
import { collectGarbageBlobs } from "./blobs";

/** Hashes per `blob.gc` job (keeps job payloads small). */
export const BLOB_GC_JOB_HASHES = 500;

export const BlobGcPayloadSchema = z.object({
  /** Only these blobs (still unreferenced when the job runs); all unreferenced ones if omitted. */
  hashes: z.array(z.string().min(1).max(128)).max(BLOB_GC_JOB_HASHES).optional(),
  graceMs: z.number().int().min(0),
});
export type BlobGcPayload = z.infer<typeof BlobGcPayloadSchema>;

/**
 * `blob.gc` (SPEC §26.3): deletes the files of blobs that are still unreferenced and have been
 * for at least `graceMs`. Enqueued after "Delete permanently" / "Empty Trash" with the purged
 * hashes; the daily maintenance keeps its own 24 h pass over everything.
 */
export const blobGcHandler: JobHandler<BlobGcPayload, { deleted: number; bytes: number }> = {
  type: "blob.gc",
  capability: "blob.gc",
  payloadSchema: BlobGcPayloadSchema,
  run: (ctx, p) =>
    collectGarbageBlobs(ctx.db, ctx.storage, Date.now(), {
      graceMs: p.graceMs,
      ...(p.hashes && { hashes: p.hashes }),
    }),
};

/**
 * Schedules the deletion of the files a purge released, `graceMs` from now (one job per
 * {@link BLOB_GC_JOB_HASHES} hashes). Call in the purge's transaction, so the jobs exist only if
 * the purge does. Returns the number of jobs.
 */
export function enqueueBlobGc(
  db: Db,
  hashes: readonly string[],
  graceMs: number,
  now: number = Date.now(),
): number {
  const unique = [...new Set(hashes)];
  let n = 0;
  for (let i = 0; i < unique.length; i += BLOB_GC_JOB_HASHES) {
    enqueueJob(
      db,
      {
        type: "blob.gc",
        capability: "blob.gc",
        payload: { hashes: unique.slice(i, i + BLOB_GC_JOB_HASHES), graceMs },
        runAfter: now + graceMs,
      },
      now,
    );
    n++;
  }
  return n;
}
