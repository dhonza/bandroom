import { uuidv7 } from "@bandroom/shared";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import { jobs } from "../db/schema";

export type JobRow = typeof jobs.$inferSelect;
export type JobStatus = JobRow["status"];

export const LEASE_MS = 60_000;
/** Error of a job whose worker stopped renewing its lease (crash, SIGKILL, OOM). */
export const LEASE_EXPIRED = "lease expired";

export interface EnqueueInput {
  type: string;
  capability: string;
  payload: unknown;
  priority?: number;
  maxAttempts?: number;
  /** Unique while queued/running; a duplicate enqueue returns the existing job. */
  dedupeKey?: string | null;
  createdBy?: string | null;
  runAfter?: number;
}

export function enqueueJob(db: Db, input: EnqueueInput, now: number = Date.now()): JobRow {
  if (input.dedupeKey) {
    const existing = db
      .select()
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, input.dedupeKey), inArray(jobs.status, ["queued", "running"])))
      .get();
    if (existing) return existing;
  }
  return db
    .insert(jobs)
    .values({
      id: uuidv7(now),
      type: input.type,
      capability: input.capability,
      payload: JSON.stringify(input.payload),
      status: "queued",
      priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 3,
      dedupeKey: input.dedupeKey ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      runAfter: input.runAfter ?? 0,
    })
    .returning()
    .get();
}

interface RawJob {
  id: string;
  type: string;
  payload: string;
  status: JobStatus;
  priority: number;
  capability: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_until: number | null;
  run_after: number;
  progress: number;
  result: string | null;
  error: string | null;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  dedupe_key: string | null;
}

function fromRaw(r: RawJob): JobRow {
  return {
    id: r.id,
    type: r.type,
    payload: r.payload,
    status: r.status,
    priority: r.priority,
    capability: r.capability,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lockedBy: r.locked_by,
    lockedUntil: r.locked_until,
    runAfter: r.run_after,
    progress: r.progress,
    result: r.result,
    error: r.error,
    createdBy: r.created_by,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    dedupeKey: r.dedupe_key,
  };
}

/** Atomically claims the next runnable job for a worker (SPEC §18.4). */
export function claimJob(
  db: Db,
  workerId: string,
  capabilities: readonly string[],
  now: number = Date.now(),
  leaseMs: number = LEASE_MS,
): JobRow | null {
  if (capabilities.length === 0) return null;
  const placeholders = capabilities.map(() => "?").join(", ");
  const row = db.$client
    .prepare(
      `UPDATE jobs SET status = 'running', locked_by = ?, locked_until = ?, attempts = attempts + 1,
         started_at = COALESCE(started_at, ?), progress = 0
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'queued' AND run_after <= ? AND capability IN (${placeholders})
         ORDER BY priority DESC, created_at ASC LIMIT 1
       )
       RETURNING *`,
    )
    .get(workerId, now + leaseMs, now, now, ...capabilities) as RawJob | undefined;
  return row ? fromRaw(row) : null;
}

/** Extends the lease and records progress; false if the job is no longer ours (e.g. cancelled). */
export function heartbeatJob(
  db: Db,
  jobId: string,
  workerId: string,
  progress: number | null,
  now: number = Date.now(),
  leaseMs: number = LEASE_MS,
): boolean {
  const patch = progress === null ? {} : { progress: Math.max(0, Math.min(1, progress)) };
  return (
    db
      .update(jobs)
      .set({ lockedUntil: now + leaseMs, ...patch })
      .where(and(eq(jobs.id, jobId), eq(jobs.lockedBy, workerId), eq(jobs.status, "running")))
      .run().changes > 0
  );
}

/** Marks a running job done; false when it no longer was running (e.g. cancelled meanwhile). */
export function completeJob(
  db: Db,
  jobId: string,
  result: unknown,
  now: number = Date.now(),
): boolean {
  return (
    db
      .update(jobs)
      .set({
        status: "done",
        progress: 1,
        result: result === undefined ? null : JSON.stringify(result),
        lockedBy: null,
        lockedUntil: null,
        finishedAt: now,
        error: null,
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")))
      .run().changes > 0
  );
}

/**
 * Puts a job interrupted by this runner's shutdown back in the queue without consuming the
 * attempt its claim counted, so a restart never turns the last attempt into a failure.
 */
export function requeueInterruptedJob(
  db: Db,
  jobId: string,
  workerId: string,
  now: number = Date.now(),
): boolean {
  return (
    db
      .update(jobs)
      .set({
        status: "queued",
        attempts: sql`max(${jobs.attempts} - 1, 0)`,
        lockedBy: null,
        lockedUntil: null,
        runAfter: now,
        error: "interrupted by shutdown",
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.lockedBy, workerId), eq(jobs.status, "running")))
      .run().changes > 0
  );
}

/** Exponential retry backoff: 10 s, 20 s, 40 s, … capped at 10 min. */
export function retryDelayMs(attempts: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, attempts - 1), 600_000);
}

/**
 * Records a failure. Retries (with backoff) while attempts remain, unless `permanent`
 * (e.g. an unsupported file will never succeed). Returns the new status.
 */
export function failJob(
  db: Db,
  jobId: string,
  error: string,
  opts: { permanent?: boolean } = {},
  now: number = Date.now(),
): JobStatus {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job || job.status !== "running") return job?.status ?? "failed";
  const retry = !opts.permanent && job.attempts < job.maxAttempts;
  db.update(jobs)
    .set(
      retry
        ? {
            status: "queued",
            error,
            lockedBy: null,
            lockedUntil: null,
            runAfter: now + retryDelayMs(job.attempts),
          }
        : { status: "failed", error, lockedBy: null, lockedUntil: null, finishedAt: now },
    )
    .where(eq(jobs.id, jobId))
    .run();
  return retry ? "queued" : "failed";
}

/**
 * Re-queues (or fails) running jobs whose lease expired before `now`, e.g. after a worker crash.
 * `lockedBy` limits it to one runner's jobs: a worker restarting may treat its own leases as
 * expired early (`now` in the future) without touching jobs other processes are running, such as
 * the API's Samply import. Each update re-checks the lease, so a heartbeat that renewed it in the
 * meantime wins. Returns the jobs it failed for good: the caller settles them
 * (`settleFailedJob`), e.g. fails the edit session a crashed render belonged to.
 */
export function recoverExpiredJobs(
  db: Db,
  now: number = Date.now(),
  opts: { lockedBy?: string } = {},
): { requeued: number; failed: JobRow[] } {
  const expired = (
    opts.lockedBy === undefined
      ? db.$client
          .prepare("SELECT * FROM jobs WHERE status = 'running' AND locked_until < ?")
          .all(now)
      : db.$client
          .prepare(
            "SELECT * FROM jobs WHERE status = 'running' AND locked_until < ? AND locked_by = ?",
          )
          .all(now, opts.lockedBy)
  ) as RawJob[];
  const stillExpired = (id: string) =>
    and(eq(jobs.id, id), eq(jobs.status, "running"), lt(jobs.lockedUntil, now));
  let requeued = 0;
  const failed: JobRow[] = [];
  for (const r of expired) {
    if (r.attempts < r.max_attempts) {
      requeued += db
        .update(jobs)
        .set({
          status: "queued",
          lockedBy: null,
          lockedUntil: null,
          error: LEASE_EXPIRED,
          runAfter: now,
        })
        .where(stillExpired(r.id))
        .run().changes;
    } else {
      const rows = db
        .update(jobs)
        .set({
          status: "failed",
          lockedBy: null,
          lockedUntil: null,
          error: LEASE_EXPIRED,
          finishedAt: now,
        })
        .where(stillExpired(r.id))
        .returning()
        .all();
      failed.push(...rows);
    }
  }
  return { requeued, failed };
}

export function cancelJob(db: Db, jobId: string, now: number = Date.now()): boolean {
  return (
    db
      .update(jobs)
      .set({ status: "cancelled", lockedBy: null, lockedUntil: null, finishedAt: now })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, ["queued", "running"])))
      .run().changes > 0
  );
}

export function getJob(db: Db, id: string): JobRow | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

/**
 * Queues a failed or cancelled job again with fresh attempts (ops API, SPEC §29.6). Returns
 * "conflict" when an equal job (same dedupe key) is already queued or running.
 */
export function requeueJob(
  db: Db,
  jobId: string,
  now: number = Date.now(),
): "requeued" | "state" | "conflict" {
  try {
    const changed = db
      .update(jobs)
      .set({
        status: "queued",
        attempts: 0,
        error: null,
        progress: 0,
        lockedBy: null,
        lockedUntil: null,
        runAfter: now,
        startedAt: null,
        finishedAt: null,
      })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, ["failed", "cancelled"])))
      .run().changes;
    return changed > 0 ? "requeued" : "state";
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint/i.test(err.message)) return "conflict";
    throw err;
  }
}
