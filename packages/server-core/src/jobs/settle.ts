import {
  EDIT_COMMIT_JOB_TYPE,
  editAssetSettled,
  editChangedEvent,
  failEditSession,
  failStuckEditSession,
  RENDER_JOB_TYPE,
} from "../content/editRenders";
import type { Db } from "../db/connection";
import { getAsset, setAssetStatus } from "../media/assets";
import { recoverExpiredJobs, type JobRow } from "./queue";
import type { JobEvent } from "./types";

export interface SettledFailure {
  /** Edit sessions that failed with the job (back to `open` with the error). */
  sessionIds: string[];
  /** What to fan out over SSE (`asset.failed`, `edit.changed`). */
  events: JobEvent[];
}

function payloadOf(job: Pick<JobRow, "payload">): Record<string, unknown> {
  try {
    const p: unknown = JSON.parse(job.payload);
    return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * The single place for "a job failed for good" (thrown on its last attempt, a permanent error,
 * or its lease ran out on the last attempt): the asset it drove is `failed` (a rendered edit's
 * session then fails through its commit), a failed `audio.render` or `edit.commit` returns its
 * edit session to `open` with the error (SPEC §24.14). Idempotent: a session that is no longer
 * applying is left alone, so a handler that already failed it causes no second event.
 */
export function settleFailedJob(
  db: Db,
  job: Pick<JobRow, "id" | "type" | "payload">,
  error: string,
  now: number = Date.now(),
): SettledFailure {
  const payload = payloadOf(job);
  const message = error.slice(0, 500);
  const events: JobEvent[] = [];
  const sessionIds: string[] = [];
  const assetId = str(payload.assetId);
  if (assetId && getAsset(db, assetId)) {
    setAssetStatus(db, assetId, "failed", message);
    // A rendered edit's ingest failed: its session fails (SPEC §24.14).
    editAssetSettled(db, assetId);
    events.push({
      type: "asset.failed",
      projectId: str(payload.projectId),
      songId: str(payload.songId),
      data: {
        jobId: job.id,
        assetId,
        trackVersionId: str(payload.trackVersionId),
        error: message,
      },
    });
  }
  const sessionId = str(payload.sessionId);
  if (sessionId && (job.type === RENDER_JOB_TYPE || job.type === EDIT_COMMIT_JOB_TYPE)) {
    const renderId = str(payload.renderId);
    const failed =
      job.type === RENDER_JOB_TYPE && renderId
        ? failEditSession(db, sessionId, renderId, message, now)
        : failStuckEditSession(db, sessionId, message, now);
    if (failed) {
      sessionIds.push(failed.id);
      const e = editChangedEvent(db, failed.id);
      if (e) events.push(e);
    }
  }
  return { sessionIds, events };
}

/**
 * {@link recoverExpiredJobs} plus {@link settleFailedJob} for each job it failed for good; the
 * events go to `emit`.
 */
export function recoverAndSettleExpiredJobs(
  db: Db,
  emit: (event: JobEvent) => void,
  now: number = Date.now(),
  opts: { lockedBy?: string } = {},
): { requeued: number; failed: JobRow[]; sessionIds: string[] } {
  const r = recoverExpiredJobs(db, now, opts);
  const sessionIds: string[] = [];
  // A restarting worker passes a `now` in the future to expire its own leases early.
  const at = Math.min(now, Date.now());
  for (const job of r.failed) {
    const settled = settleFailedJob(db, job, job.error ?? "failed", at);
    sessionIds.push(...settled.sessionIds);
    for (const e of settled.events) emit(e);
  }
  return { ...r, sessionIds };
}
