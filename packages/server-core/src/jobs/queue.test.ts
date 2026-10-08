import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/connection";
import { createTestDb } from "../testing/testDb";
import {
  cancelJob,
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  getJob,
  requeueJob,
  heartbeatJob,
  LEASE_MS,
  recoverExpiredJobs,
  retryDelayMs,
} from "./queue";

let t: ReturnType<typeof createTestDb>;
let db: Db;
beforeEach(() => {
  t = createTestDb();
  db = t.db;
});
afterEach(() => {
  t.close();
});

const add = (type: string, extra: Partial<Parameters<typeof enqueueJob>[1]> = {}, now = 1000) =>
  enqueueJob(db, { type, capability: type, payload: { n: type }, ...extra }, now);

describe("job queue (SPEC §18.4)", () => {
  it("claims by priority, then age, only for offered capabilities", () => {
    add("a", {}, 1);
    add("b", { priority: 5 }, 2);
    add("c", {}, 3);
    expect(claimJob(db, "w", ["x"], 10)).toBeNull();
    expect(claimJob(db, "w", ["a", "b", "c"], 10)?.type).toBe("b");
    expect(claimJob(db, "w", ["a", "b", "c"], 10)?.type).toBe("a");
    const c = claimJob(db, "w", ["c"], 10);
    expect(c).toMatchObject({
      type: "c",
      status: "running",
      attempts: 1,
      lockedBy: "w",
      lockedUntil: 10 + LEASE_MS,
    });
    expect(claimJob(db, "w", ["a", "b", "c"], 10)).toBeNull();
  });

  it("deduplicates while queued or running, not after completion", () => {
    const first = add("mix", { dedupeKey: "song:1" });
    expect(add("mix", { dedupeKey: "song:1" }).id).toBe(first.id);
    claimJob(db, "w", ["mix"], 2000);
    expect(add("mix", { dedupeKey: "song:1" }).id).toBe(first.id);
    completeJob(db, first.id, { ok: 1 });
    expect(add("mix", { dedupeKey: "song:1" }).id).not.toBe(first.id);
    expect(getJob(db, first.id)).toMatchObject({ status: "done", progress: 1, result: '{"ok":1}' });
  });

  it("retries with backoff until maxAttempts, and fails permanent errors at once", () => {
    const j = add("x", { maxAttempts: 2 });
    claimJob(db, "w", ["x"], 1000);
    expect(failJob(db, j.id, "boom", {}, 1000)).toBe("queued");
    expect(getJob(db, j.id)?.runAfter).toBe(1000 + retryDelayMs(1));
    expect(claimJob(db, "w", ["x"], 1001)).toBeNull(); // backoff
    claimJob(db, "w", ["x"], 1000 + retryDelayMs(1));
    expect(failJob(db, j.id, "boom again", {}, 30_000)).toBe("failed");
    expect(getJob(db, j.id)).toMatchObject({ status: "failed", attempts: 2, error: "boom again" });

    const p = add("x");
    claimJob(db, "w", ["x"], 50_000);
    expect(failJob(db, p.id, "unsupported", { permanent: true })).toBe("failed");
    expect(retryDelayMs(1)).toBe(10_000);
    expect(retryDelayMs(3)).toBe(40_000);
    expect(retryDelayMs(20)).toBe(600_000);
  });

  it("renews leases, recovers expired ones, and stops cancelled jobs", () => {
    const j = add("x", { maxAttempts: 2 });
    claimJob(db, "w", ["x"], 0);
    expect(heartbeatJob(db, j.id, "w", 0.5, 30_000)).toBe(true);
    expect(getJob(db, j.id)).toMatchObject({ progress: 0.5, lockedUntil: 30_000 + LEASE_MS });
    expect(heartbeatJob(db, j.id, "other", null, 30_000)).toBe(false);

    expect(recoverExpiredJobs(db, 30_000 + LEASE_MS + 1)).toEqual({ requeued: 1, failed: 0 });
    claimJob(db, "w", ["x"], 200_000);
    expect(recoverExpiredJobs(db, 200_000 + LEASE_MS + 1)).toEqual({ requeued: 0, failed: 1 });

    const k = add("x");
    claimJob(db, "w", ["x"], 300_000);
    expect(cancelJob(db, k.id)).toBe(true);
    expect(heartbeatJob(db, k.id, "w", 0.1, 300_001)).toBe(false);
    expect(cancelJob(db, k.id)).toBe(false);
  });
});

describe("recoverExpiredJobs", () => {
  it("limits startup recovery to the worker's own jobs", () => {
    const own = add("ingest");
    const api = add("samply.import");
    claimJob(db, "local-host", ["ingest"], 10_000);
    claimJob(db, "server-123", ["samply.import"], 10_000);
    // Worker startup: its own leases count as expired at once, live API jobs are left alone.
    const startup = 20_000 + 10 * 60_000;
    expect(recoverExpiredJobs(db, startup, { lockedBy: "local-host" })).toEqual({
      requeued: 1,
      failed: 0,
    });
    expect(getJob(db, own.id)).toMatchObject({ status: "queued", lockedBy: null });
    expect(getJob(db, api.id)).toMatchObject({ status: "running", lockedBy: "server-123" });
    // The periodic check with the real time still recovers any runner's expired lease.
    expect(recoverExpiredJobs(db, 20_000)).toEqual({ requeued: 0, failed: 0 });
    expect(recoverExpiredJobs(db, 10_000 + LEASE_MS + 1)).toEqual({ requeued: 1, failed: 0 });
    expect(getJob(db, api.id)).toMatchObject({ status: "queued" });
  });

  it("leaves a job whose lease a heartbeat renewed after the scan", () => {
    const j = add("x");
    claimJob(db, "w", ["x"], 10_000);
    const late = 10_000 + LEASE_MS + 1;
    const stale = db.$client.prepare("SELECT * FROM jobs WHERE id = ?").all(j.id);
    // The runner renews its lease between the SELECT and the UPDATE.
    expect(heartbeatJob(db, j.id, "w", null, late)).toBe(true);
    const prepare = db.$client.prepare.bind(db.$client);
    const spy = vi
      .spyOn(db.$client, "prepare")
      .mockImplementation(((sql: string) =>
        sql.startsWith("SELECT * FROM jobs WHERE status = 'running'")
          ? { all: () => stale }
          : prepare(sql)) as typeof db.$client.prepare);
    try {
      expect(recoverExpiredJobs(db, late)).toEqual({ requeued: 0, failed: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(getJob(db, j.id)).toMatchObject({ status: "running", lockedBy: "w" });
  });
});

describe("requeueJob", () => {
  it("queues failed and cancelled jobs again, refuses others and duplicates", () => {
    const a = add("t", { dedupeKey: "k" });
    expect(requeueJob(db, a.id)).toBe("state");
    cancelJob(db, a.id);
    expect(requeueJob(db, a.id, 5)).toBe("requeued");
    expect(getJob(db, a.id)).toMatchObject({ status: "queued", attempts: 0, runAfter: 5 });
    cancelJob(db, a.id);
    add("t", { dedupeKey: "k" });
    expect(requeueJob(db, a.id)).toBe("conflict");
    expect(requeueJob(db, "missing")).toBe("state");
  });
});
