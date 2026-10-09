import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  diskUsage,
  getUsage,
  getUserById,
  logFilePath,
  readLogRecords,
  cancelJob,
  getAsset,
  requeueJob,
  setAssetStatus,
  type Db,
  type LogSource,
  type UserRow,
} from "@bandroom/server-core";
import {
  cancelAdminJob,
  getAdminEvents,
  getAdminJobs,
  getAdminLogs,
  getAdminStorage,
  getAdminSystem,
  getAdminUploads,
  LOG_LEVELS,
  retryAdminJob,
  type AdminEvent,
  type AdminJob,
  type AdminLogRecord,
} from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";
import { effectiveQuota } from "../quota";

/** Status files larger than this are not parsed (they are written by our own scripts). */
const STATUS_FILE_MAX_BYTES = 256 * 1024;

/** A JSON object from a status file, or null when missing, too large or not an object. */
export function readStatusFile(file: string): Record<string, unknown> | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > STATUS_FILE_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `DATA_DIR/ops`: the update request/result files and the watcher's host status (SPEC §29.8). */
export function opsDir(dataDir: string): string {
  return path.join(dataDir, "ops");
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

interface RawJob {
  id: string;
  type: string;
  status: AdminJob["status"];
  attempts: number;
  max_attempts: number;
  progress: number;
  error: string | null;
  locked_by: string | null;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  run_after: number;
  payload: string;
}

/** Only `…Id` string fields of a job payload: never secrets or other values. */
function refsOf(payload: string): Record<string, string> {
  try {
    const p: unknown = JSON.parse(payload);
    if (typeof p !== "object" || p === null) return {};
    return Object.fromEntries(
      Object.entries(p).filter(
        (e): e is [string, string] => /Id$/.test(e[0]) && typeof e[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function toAdminJob(r: RawJob): AdminJob {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    progress: r.progress,
    error: r.error,
    lockedBy: r.locked_by,
    createdBy: r.created_by,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    runAfter: r.run_after,
    refs: refsOf(r.payload),
  };
}

export function getRawJob(db: Db, id: string): RawJob | undefined {
  return db.$client.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as RawJob | undefined;
}

function parseDetails(details: string | null): unknown {
  if (details === null) return null;
  try {
    return JSON.parse(details) as unknown;
  } catch {
    return details;
  }
}

/** Ops read endpoints (SPEC §29.6). */
export function registerOpsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;
  const startedAt = Date.now();

  registerContract(app, getAdminSystem, async () => {
    const disk = await diskUsage(config.dataDir).catch(() => null);
    const blobs = db.$client
      .prepare("SELECT count(*) AS count, coalesce(sum(size_bytes), 0) AS bytes FROM blobs")
      .get() as { count: number; bytes: number };
    const usage = db.$client
      .prepare("SELECT coalesce(sum(bytes), 0) AS bytes FROM user_usage")
      .get() as { bytes: number };
    const workers = db.$client
      .prepare(
        "SELECT id, name, kind, last_seen_at, version FROM workers ORDER BY last_seen_at DESC",
      )
      .all() as {
      id: string;
      name: string;
      kind: string;
      last_seen_at: number | null;
      version: string | null;
    }[];
    return {
      now: Date.now(),
      version: ctx.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      node: process.version,
      rssBytes: process.memoryUsage.rss(),
      loadavg: os.loadavg(),
      disk,
      dbBytes: fileSize(config.dbPath) + fileSize(`${config.dbPath}-wal`),
      blobs,
      usageBytes: usage.bytes,
      config: {
        nodeEnv: config.nodeEnv,
        basePath: config.basePath,
        logLevel: config.logLevel,
        defaultLocale: config.defaultLocale,
        maxUploadBytes: config.maxUploadBytes,
        trustProxy: config.trustProxy,
        workerConcurrency: config.workerConcurrency,
        updateImageRepo: config.updateImageRepo,
      },
      workers: workers.map((w) => ({
        id: w.id,
        name: w.name,
        kind: w.kind,
        lastSeenAt: w.last_seen_at,
        version: w.version,
      })),
      backup: readStatusFile(path.join(config.dataDir, "backup", "status.json")),
      hostStatus: readStatusFile(path.join(opsDir(config.dataDir), "host-status.json")),
    };
  });

  registerContract(app, getAdminJobs, ({ query }) => {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (query.status) {
      where.push("status = ?");
      args.push(query.status);
    }
    if (query.type) {
      where.push("type = ?");
      args.push(query.type);
    }
    if (query.before !== undefined) {
      where.push("created_at < ?");
      args.push(query.before);
    }
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = db.$client.prepare(sql).all(...args, query.limit) as RawJob[];
    const counts = Object.fromEntries(
      (
        db.$client.prepare("SELECT status, count(*) AS n FROM jobs GROUP BY status").all() as {
          status: string;
          n: number;
        }[]
      ).map((r) => [r.status, r.n]),
    );
    return { jobs: rows.map(toAdminJob), counts };
  });

  registerContract(app, getAdminEvents, ({ query }) => {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const add = (cond: string, v: string | number | undefined) => {
      if (v === undefined) return;
      where.push(cond);
      args.push(v);
    };
    add("e.ts >= ?", query.since);
    add("e.ts < ?", query.until);
    add("e.action = ?", query.action);
    add("e.actor_user_id = ?", query.actorUserId);
    add("e.project_id = ?", query.projectId);
    add("e.id < ?", query.cursor);
    const rows = db.$client
      .prepare(
        `SELECT e.*, u.display_name AS actor_name FROM events e
         LEFT JOIN users u ON u.id = e.actor_user_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY e.id DESC LIMIT ?`,
      )
      .all(...args, query.limit + 1) as {
      id: string;
      ts: number;
      actor_type: string;
      actor_user_id: string | null;
      actor_name: string | null;
      api_key_id: string | null;
      link_id: string | null;
      action: string;
      project_id: string | null;
      song_id: string | null;
      target_type: string | null;
      target_id: string | null;
      ip: string | null;
      details: string | null;
    }[];
    const page = rows.slice(0, query.limit);
    const events: AdminEvent[] = page.map((r) => ({
      id: r.id,
      ts: r.ts,
      actorType: r.actor_type,
      actorUserId: r.actor_user_id,
      actorName: r.actor_name,
      apiKeyId: r.api_key_id,
      linkId: r.link_id,
      action: r.action,
      projectId: r.project_id,
      songId: r.song_id,
      targetType: r.target_type,
      targetId: r.target_id,
      ip: r.ip,
      details: parseDetails(r.details),
    }));
    return {
      events,
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  });

  registerContract(app, getAdminStorage, async () => {
    const ids = db.$client
      .prepare("SELECT id FROM users WHERE deleted_at IS NULL ORDER BY username")
      .all() as { id: string }[];
    const list = ids
      .map((r) => getUserById(db, r.id))
      .filter((u): u is UserRow => u !== undefined)
      .map((u) => ({
        userId: u.id,
        username: u.username,
        displayName: u.displayName,
        usedBytes: getUsage(db, u.id),
        quotaBytes: effectiveQuota(ctx, u),
      }));
    const blobs = db.$client
      .prepare("SELECT count(*) AS count, coalesce(sum(size_bytes), 0) AS bytes FROM blobs")
      .get() as { count: number; bytes: number };
    const usage = db.$client
      .prepare("SELECT coalesce(sum(bytes), 0) AS bytes FROM user_usage")
      .get() as { bytes: number };
    const disk = await diskUsage(config.dataDir).catch(() => null);
    return {
      users: list,
      totals: {
        usageBytes: usage.bytes,
        blobBytes: blobs.bytes,
        blobCount: blobs.count,
        diskFreeBytes: disk?.freeBytes ?? null,
        diskTotalBytes: disk?.totalBytes ?? null,
      },
    };
  });

  registerContract(app, getAdminUploads, ({ query }) => {
    const since = Date.now() - query.hours * 3600_000;
    const rows = db.$client
      .prepare(
        `SELECT v.id, v.number, v.created_at, v.source, v.deleted_at,
                p.id AS project_id, p.name AS project_name, s.id AS song_id, s.title AS song_title,
                t.id AS track_id, t.name AS track_name, u.username AS uploader,
                a.status, a.error, a.original_filename, a.size_bytes
         FROM track_versions v
         JOIN tracks t ON t.id = v.track_id
         JOIN songs s ON s.id = t.song_id
         JOIN projects p ON p.id = s.project_id
         JOIN assets a ON a.id = v.asset_id
         LEFT JOIN users u ON u.id = v.uploaded_by
         WHERE v.created_at >= ? AND v.edit_session_id IS NULL
         ORDER BY v.created_at DESC LIMIT ?`,
      )
      .all(since, query.limit) as {
      id: string;
      number: number;
      created_at: number;
      source: string;
      deleted_at: number | null;
      project_id: string;
      project_name: string;
      song_id: string;
      song_title: string;
      track_id: string;
      track_name: string;
      uploader: string | null;
      status: string;
      error: string | null;
      original_filename: string;
      size_bytes: number;
    }[];
    return {
      uploads: rows.map((r) => ({
        versionId: r.id,
        number: r.number,
        createdAt: r.created_at,
        source: r.source,
        projectId: r.project_id,
        projectName: r.project_name,
        songId: r.song_id,
        songTitle: r.song_title,
        trackId: r.track_id,
        trackName: r.track_name,
        uploader: r.uploader,
        status: r.status,
        error: r.error,
        filename: r.original_filename,
        sizeBytes: r.size_bytes,
        deleted: r.deleted_at !== null,
      })),
    };
  });

  registerContract(app, getAdminLogs, ({ query }) => {
    const sources: LogSource[] = query.source === "all" ? ["app", "worker"] : [query.source];
    const records: AdminLogRecord[] = sources
      .flatMap((source) =>
        readLogRecords(logFilePath(config.dataDir, source), {
          minLevel: LOG_LEVELS[query.level],
          since: query.since,
          limit: query.limit,
        }).map((r) => ({ source, ...r })),
      )
      .sort((a, b) => a.time - b.time)
      .slice(-query.limit);
    return { records };
  });

  // --- Job actions (admin:ops) -----------------------------------------------------------------

  const jobOr404 = (id: string) => {
    const job = getRawJob(db, id);
    if (!job) throw new AppError("NOT_FOUND", "Job not found");
    return job;
  };

  registerContract(app, retryAdminJob, ({ params }, request) => {
    const before = jobOr404(params.id);
    const result = requeueJob(db, params.id);
    if (result === "conflict")
      throw new AppError("JOB_STATE", "An equal job is already queued or running");
    if (result === "state")
      throw new AppError("JOB_STATE", "Only failed or cancelled jobs can be retried");
    // A failed media job left its asset failed; it is waiting for processing again.
    const assetId = toAdminJob(before).refs.assetId;
    const asset = assetId ? getAsset(db, assetId) : undefined;
    if (asset?.status === "failed") setAssetStatus(db, asset.id, "queued");
    audit(db, request, {
      action: "job.retried",
      targetType: "job",
      targetId: params.id,
      details: { type: before.type, previousStatus: before.status },
    });
    return { job: toAdminJob(jobOr404(params.id)) };
  });

  registerContract(app, cancelAdminJob, ({ params }, request) => {
    const before = jobOr404(params.id);
    if (!cancelJob(db, params.id))
      throw new AppError("JOB_STATE", "Only queued or running jobs can be cancelled");
    audit(db, request, {
      action: "job.cancelled",
      targetType: "job",
      targetId: params.id,
      details: { type: before.type, previousStatus: before.status },
    });
    return { job: toAdminJob(jobOr404(params.id)) };
  });
}
