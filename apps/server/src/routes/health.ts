import fs from "node:fs/promises";
import { diskUsage, latestLocalWorkerHeartbeat, type Db } from "@bandroom/server-core";
import type { FastifyInstance } from "fastify";

/** Below this, `/healthz` reports `degraded` (SPEC §15.2 notifies admins below 1.5 GB). */
export const DISK_LOW_BYTES = 1.5 * 1024 ** 3;
/** The worker heartbeats every 30 s; two minutes of silence means it is down. */
export const WORKER_STALE_MS = 2 * 60_000;

export interface HealthDeps {
  db: Db;
  dataDir: string;
  version: string;
}

type CheckResult = { ok: boolean };

async function check(fn: () => unknown): Promise<CheckResult> {
  try {
    await fn();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * `GET {basePath}/healthz` (and `/healthz` for container health checks): DB, data dir, free disk.
 * Returns 503 only when the instance cannot work; low disk or a silent worker is `degraded`.
 */
export function registerHealth(app: FastifyInstance, basePath: string, deps: HealthDeps): void {
  const handler = async () => {
    const db = await check(() => deps.db.$client.prepare("SELECT 1").get());
    const dataDir = await check(() => fs.access(deps.dataDir, fs.constants.W_OK));
    let diskOk: boolean;
    try {
      diskOk = (await diskUsage(deps.dataDir)).freeBytes >= DISK_LOW_BYTES;
    } catch {
      diskOk = false;
    }
    const beat = db.ok ? latestLocalWorkerHeartbeat(deps.db) : null;
    const worker = { ok: beat !== null && Date.now() - beat < WORKER_STALE_MS };
    const fatal = !db.ok || !dataDir.ok;
    return {
      status: fatal ? "error" : diskOk && worker.ok ? "ok" : "degraded",
      version: deps.version,
      checks: { db, dataDir, disk: { ok: diskOk }, worker },
    };
  };

  const paths = new Set(["/healthz", `${basePath}/healthz`]);
  for (const url of paths) {
    app.get(url, async (_request, reply) => {
      const result = await handler();
      return reply
        .status(result.status === "error" ? 503 : 200)
        .header("Cache-Control", "no-store")
        .send(result);
    });
  }
}
