import { getEventListeners } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Db } from "../db/connection";
import { ToolTimeoutError } from "../media/tools";
import { LocalStorage } from "../storage/local";
import { makeTempDir } from "../testing/tempDir";
import { createTestDb } from "../testing/testDb";
import { cancelJob, claimJob, enqueueJob, getJob } from "./queue";
import { executeJob, handlerRegistry, sweepJobTmp, type RunnerDeps } from "./runner";
import { PermanentJobError, type JobContext, type JobEvent, type JobHandler } from "./types";

let t: ReturnType<typeof createTestDb>;
let db: Db;
let tmp: ReturnType<typeof makeTempDir>;
let events: JobEvent[];
beforeEach(() => {
  t = createTestDb();
  db = t.db;
  tmp = makeTempDir();
  events = [];
});
afterEach(() => {
  t.close();
  tmp.cleanup();
});

const Payload = z.object({ assetId: z.string().optional() });
type Run = (ctx: JobContext) => Promise<unknown>;

function handler(run: Run): JobHandler<z.infer<typeof Payload>> {
  return { type: "t", capability: "t", payloadSchema: Payload, run: (ctx) => run(ctx) };
}

function deps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    db,
    storage: new LocalStorage(path.join(tmp.dir, "blobs")),
    workerId: "w",
    tmpRoot: tmp.dir,
    emit: (e) => events.push(e),
    ...extra,
  };
}

function claim(maxAttempts = 3) {
  enqueueJob(db, { type: "t", capability: "t", payload: {}, maxAttempts });
  const job = claimJob(db, "w", ["t"]);
  if (!job) throw new Error("no job");
  return job;
}

describe("executeJob (SPEC §18.4)", () => {
  it("completes a job, emits asset.ready and removes its temp dir", async () => {
    let dir = "";
    const h = handler((ctx) => {
      dir = ctx.tmpDir;
      return Promise.resolve({ ok: true });
    });
    const job = claim();
    expect(await executeJob(deps(), handlerRegistry([h]), job)).toBe("done");
    expect(getJob(db, job.id)?.status).toBe("done");
    expect(events.map((e) => e.type)).toEqual(["asset.ready"]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("retries ordinary errors and fails permanent ones at once", async () => {
    const job = claim();
    const flaky = handler(() => Promise.reject(new Error("boom")));
    expect(await executeJob(deps(), handlerRegistry([flaky]), job)).toBe("queued");
    expect(getJob(db, job.id)).toMatchObject({ status: "queued", error: "boom" });

    const job2 = claim();
    const bad = handler(() => Promise.reject(new PermanentJobError("unsupported")));
    expect(await executeJob(deps(), handlerRegistry([bad]), job2)).toBe("failed");
    expect(getJob(db, job2.id)?.status).toBe("failed");
  });

  it("does not accumulate abort listeners on the shared shutdown signal", async () => {
    const shutdown = new AbortController();
    const h = handler(() => Promise.resolve(null));
    for (let i = 0; i < 15; i++) {
      await executeJob(deps({ signal: shutdown.signal }), handlerRegistry([h]), claim());
    }
    expect(getEventListeners(shutdown.signal, "abort")).toHaveLength(0);
  });

  it("aborts the job when the shutdown signal fires", async () => {
    const shutdown = new AbortController();
    let seen: AbortSignal | null = null;
    const h = handler(
      (ctx) =>
        new Promise((_resolve, reject) => {
          seen = ctx.signal;
          ctx.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
          shutdown.abort();
        }),
    );
    await executeJob(deps({ signal: shutdown.signal }), handlerRegistry([h]), claim());
    expect(seen).not.toBeNull();
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
  });

  it("aborts the job when its heartbeat finds it cancelled", async () => {
    const job = claim();
    const h = handler(
      (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
          cancelJob(db, job.id);
        }),
    );
    await executeJob(deps({ heartbeatMs: 5 }), handlerRegistry([h]), job);
    expect(getJob(db, job.id)?.status).toBe("cancelled");
  });
});

describe("executeJob cancel and shutdown (review M16)", () => {
  it("emits no asset.ready for a job cancelled while it ran", async () => {
    const job = claim();
    const h = handler(() => {
      cancelJob(db, job.id);
      return Promise.resolve(null);
    });
    expect(await executeJob(deps(), handlerRegistry([h]), job)).toBe("failed");
    expect(getJob(db, job.id)?.status).toBe("cancelled");
    expect(events).toEqual([]);
  });

  it("re-queues a job interrupted by shutdown without using up its last attempt", async () => {
    const job = claim(1);
    expect(job.attempts).toBe(1);
    const shutdown = new AbortController();
    const h = handler(
      (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
          shutdown.abort();
        }),
    );
    expect(await executeJob(deps({ signal: shutdown.signal }), handlerRegistry([h]), job)).toBe(
      "queued",
    );
    expect(getJob(db, job.id)).toMatchObject({ status: "queued", attempts: 0, lockedBy: null });
    expect(claimJob(db, "w", ["t"])?.id).toBe(job.id);
  });
});

describe("executeJob time limits (review M4)", () => {
  it("fails a job whose tool timed out at once instead of retrying it", async () => {
    const job = claim();
    const h = handler(() => Promise.reject(new ToolTimeoutError("ffmpeg", "")));
    expect(await executeJob(deps(), handlerRegistry([h]), job)).toBe("failed");
    expect(getJob(db, job.id)).toMatchObject({ status: "failed", error: "ffmpeg timed out" });
  });
});

describe("sweepJobTmp", () => {
  it("removes leftover job-* dirs and files but keeps other entries", async () => {
    const root = path.join(tmp.dir, "jobs");
    fs.mkdirSync(path.join(root, "job-abc-123", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "job-abc-123", "nested", "x.wav"), "x");
    fs.writeFileSync(path.join(root, "job-stray"), "x");
    fs.mkdirSync(path.join(root, "keep"));
    expect(await sweepJobTmp(root)).toBe(2);
    expect(fs.readdirSync(root)).toEqual(["keep"]);
  });

  it("returns 0 for a missing root", async () => {
    expect(await sweepJobTmp(path.join(tmp.dir, "missing"))).toBe(0);
  });
});
