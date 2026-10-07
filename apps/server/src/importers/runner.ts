import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  claimJob,
  executeJob,
  handlerRegistry,
  recoverExpiredJobs,
  sweepJobTmp,
  type Db,
  type JobHandler,
  type StorageBackend,
} from "@bandroom/server-core";
import type { EventHub } from "../realtime/hub";

const IDLE_POLL_MS = 2000;

/**
 * Runs network-bound jobs (the Samply importer) inside the API process, one at a time. They need
 * no ffmpeg, so they do not compete with the worker's media jobs (SPEC §17.1 step 5).
 */
export function startJobRunner(opts: {
  db: Db;
  storage: StorageBackend;
  hub: EventHub;
  handlers: readonly JobHandler[];
  /** Server temp dir (`config.tmpDir`); jobs get a private `server-jobs` subdir. */
  tmpDir: string;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}): { stop: () => Promise<void> } {
  const registry = handlerRegistry(opts.handlers);
  const capabilities = [...registry.values()].map((h) => h.capability);
  const workerId = `server-${process.pid}`;
  const tmpRoot = path.join(opts.tmpDir, "server-jobs");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const abort = new AbortController();

  const loop = (async () => {
    // Dirs left by a crashed previous process (its jobs were or will be re-claimed afresh).
    const swept = await sweepJobTmp(tmpRoot);
    if (swept > 0) opts.log("removed stale job temp dirs", { count: swept });
    let lastRecover = 0;
    while (!abort.signal.aborted) {
      const now = Date.now();
      if (now - lastRecover > 30_000) {
        recoverExpiredJobs(opts.db, now);
        lastRecover = now;
      }
      const job = claimJob(opts.db, workerId, capabilities);
      if (!job) {
        await sleep(IDLE_POLL_MS, undefined, { signal: abort.signal }).catch(() => undefined);
        continue;
      }
      const status = await executeJob(
        {
          db: opts.db,
          storage: opts.storage,
          workerId,
          tmpRoot,
          emit: (e) => {
            opts.hub.publish(e);
          },
          log: opts.log,
          signal: abort.signal,
        },
        registry,
        job,
      );
      opts.log("server job finished", { jobId: job.id, type: job.type, status });
    }
  })();

  return {
    stop: async () => {
      abort.abort();
      await loop;
    },
  };
}
