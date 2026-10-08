import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  audioBounceHandler,
  audioIngestHandler,
  audioReencodeHandler,
  blobGcHandler,
  claimJob,
  createLogger,
  executeJob,
  handlerRegistry,
  heartbeatWorker,
  loadConfig,
  LocalStorage,
  openDb,
  recoverExpiredJobs,
  sweepJobTmp,
} from "@bandroom/server-core";
import { documentIngestHandler, imageIngestHandler } from "@bandroom/server-core/image";
import pkg from "../package.json" with { type: "json" };
import { startAliveFile } from "./alive";
import { EventForwarder } from "./events";
import { maintenanceTick } from "./maintenance";
import { MIGRATIONS_DIR } from "./paths";
import { waitForMigrations } from "./waitForMigrations";

const IDLE_POLL_MS = 1000;
const HEARTBEAT_MS = 30_000;
const HANDLERS = handlerRegistry([
  audioIngestHandler,
  audioBounceHandler,
  audioReencodeHandler,
  imageIngestHandler,
  documentIngestHandler,
  blobGcHandler,
]);
const CAPABILITIES = [...HANDLERS.values()].map((h) => h.capability);

/**
 * Local job runner (SPEC §18.4): claims one job at a time, runs it with niced media tools,
 * forwards progress to the API, and performs daily maintenance.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config, "worker", "worker");
  for (const w of config.warnings) logger.warn(w);
  const version = process.env.APP_VERSION ?? pkg.version;

  const abort = new AbortController();
  const stop = (signal: string) => {
    logger.info({ signal }, "shutting down");
    abort.abort();
  };
  process.once("SIGTERM", () => {
    stop("SIGTERM");
  });
  process.once("SIGINT", () => {
    stop("SIGINT");
  });

  const db = openDb(config.dbPath);
  const storage = new LocalStorage(config.blobsDir);
  const jobTmp = path.join(config.tmpDir, "jobs");
  await fs.mkdir(jobTmp, { recursive: true });
  // Temp dirs of jobs this worker was running when it was killed (SIGKILL, OOM).
  const swept = await sweepJobTmp(jobTmp);
  if (swept > 0) logger.info({ count: swept }, "removed stale job temp dirs");
  const workerId = `local-${os.hostname()}`;
  const events = new EventForwarder(
    `${config.internalApiUrl}/internal/events`,
    config.internalEventsSecret,
    (err) => {
      logger.warn({ err }, "could not forward job events");
    },
  );
  const beat = () => {
    heartbeatWorker(db, {
      id: workerId,
      name: workerId,
      kind: "local",
      capabilities: CAPABILITIES,
      version,
    });
  };

  // Container health check (deploy/compose.yml); unset outside Docker.
  const stopAlive = startAliveFile(process.env.WORKER_ALIVE_FILE, (err) => {
    logger.warn({ err }, "could not refresh the liveness file");
  });

  try {
    await waitForMigrations(db.$client, MIGRATIONS_DIR, {
      signal: abort.signal,
      onWait: (pending) => {
        logger.info({ pending }, "waiting for the server to apply migrations");
      },
    });
    beat();
    // Jobs left "running" by a previous run of this worker are re-queued at once, ignoring their
    // lease. Other runners' jobs (e.g. the API's Samply import) are left to the periodic check.
    recoverExpiredJobs(db, Date.now() + 10 * 60_000, { lockedBy: workerId });
    logger.info({ capabilities: CAPABILITIES, concurrency: 1 }, "worker ready");

    let lastBeat = Date.now();
    let lastRecover = Date.now();
    const maintenance = { retryAfter: 0 };
    const maintenanceLog = {
      info: (obj: object, msg: string) => {
        logger.info(obj, msg);
      },
      error: (obj: object, msg: string) => {
        logger.error(obj, msg);
      },
    };
    while (!abort.signal.aborted) {
      const now = Date.now();
      // Housekeeping failures (e.g. a busy database) are logged; the loop keeps running jobs.
      if (now - lastBeat >= HEARTBEAT_MS) {
        lastBeat = now;
        try {
          beat();
        } catch (err) {
          logger.error({ err }, "worker heartbeat failed");
        }
      }
      if (now - lastRecover >= 30_000) {
        lastRecover = now;
        try {
          recoverExpiredJobs(db, now);
        } catch (err) {
          logger.error({ err }, "recovering expired jobs failed");
        }
      }
      await maintenanceTick({ db, storage, log: maintenanceLog, state: maintenance });

      const job = claimJob(db, workerId, CAPABILITIES);
      if (!job) {
        await sleep(IDLE_POLL_MS, undefined, { signal: abort.signal }).catch(() => undefined);
        continue;
      }
      logger.info({ jobId: job.id, type: job.type, attempt: job.attempts }, "job started");
      const status = await executeJob(
        {
          db,
          storage,
          workerId,
          tmpRoot: jobTmp,
          emit: (e) => {
            events.emit(e);
          },
          log: (msg, extra) => {
            logger.info(extra ?? {}, msg);
          },
          signal: abort.signal,
        },
        HANDLERS,
        job,
      );
      logger.info({ jobId: job.id, type: job.type, status }, "job finished");
    }
  } finally {
    stopAlive();
    await events.flush();
    db.$client.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
