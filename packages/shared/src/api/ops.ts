import { z } from "zod";
import { defineContract } from "./contract";

// Ops API (SPEC §29.6): admin-only; keys need admin:read (GET) or admin:ops (POST).

const admin = { global: "admin.access" } as const;

/** A JSON object read from a status file on the data disk (shape owned by its writer). */
const StatusFileSchema = z.record(z.string(), z.unknown()).nullable();

export const AdminSystemSchema = z.object({
  now: z.number(),
  version: z.string(),
  uptimeSec: z.number(),
  node: z.string(),
  rssBytes: z.number(),
  loadavg: z.array(z.number()),
  disk: z.object({ freeBytes: z.number(), totalBytes: z.number() }).nullable(),
  dbBytes: z.number(),
  blobs: z.object({ count: z.number(), bytes: z.number() }),
  /** Sum of all users' storage usage (SPEC §15.1). */
  usageBytes: z.number(),
  /** Non-secret configuration. */
  config: z.object({
    nodeEnv: z.string(),
    basePath: z.string(),
    logLevel: z.string(),
    defaultLocale: z.string(),
    maxUploadBytes: z.number(),
    trustProxy: z.boolean(),
    workerConcurrency: z.number(),
    updateImageRepo: z.string(),
  }),
  workers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      lastSeenAt: z.number().nullable(),
      version: z.string().nullable(),
    }),
  ),
  /** `DATA_DIR/backup/status.json` when present. */
  backup: StatusFileSchema,
  /** `DATA_DIR/ops/host-status.json`, written by the host watcher (SPEC §29.8). */
  hostStatus: StatusFileSchema,
});
export type AdminSystem = z.infer<typeof AdminSystemSchema>;

export const getAdminSystem = defineContract({
  method: "GET",
  path: "/admin/system",
  response: AdminSystemSchema,
  auth: admin,
});

export const JOB_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);

export const AdminJobSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: JobStatusSchema,
  attempts: z.number(),
  maxAttempts: z.number(),
  progress: z.number(),
  error: z.string().nullable(),
  lockedBy: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  runAfter: z.number(),
  /** Only the payload's id fields (`…Id`), never other values. */
  refs: z.record(z.string(), z.string()),
});
export type AdminJob = z.infer<typeof AdminJobSchema>;

export const getAdminJobs = defineContract({
  method: "GET",
  path: "/admin/jobs",
  query: z.object({
    status: JobStatusSchema.optional(),
    type: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    /** Only jobs created before this time (paging). */
    before: z.coerce.number().int().optional(),
  }),
  response: z.object({
    jobs: z.array(AdminJobSchema),
    /** All jobs per status. */
    counts: z.record(z.string(), z.number()),
  }),
  auth: admin,
});

const JobIdParams = z.object({ id: z.string().min(1).max(64) });

export const retryAdminJob = defineContract({
  method: "POST",
  path: "/admin/jobs/:id/retry",
  params: JobIdParams,
  response: z.object({ job: AdminJobSchema }),
  errors: ["NOT_FOUND", "JOB_STATE"],
  auth: admin,
});

export const cancelAdminJob = defineContract({
  method: "POST",
  path: "/admin/jobs/:id/cancel",
  params: JobIdParams,
  response: z.object({ job: AdminJobSchema }),
  errors: ["NOT_FOUND", "JOB_STATE"],
  auth: admin,
});

export const AdminEventSchema = z.object({
  id: z.string(),
  ts: z.number(),
  actorType: z.string(),
  actorUserId: z.string().nullable(),
  actorName: z.string().nullable(),
  apiKeyId: z.string().nullable(),
  linkId: z.string().nullable(),
  action: z.string(),
  projectId: z.string().nullable(),
  songId: z.string().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
  details: z.unknown(),
});
export type AdminEvent = z.infer<typeof AdminEventSchema>;

/** The audit log (SPEC §14.1; its UI comes with M13), newest first. */
export const getAdminEvents = defineContract({
  method: "GET",
  path: "/admin/events",
  query: z.object({
    since: z.coerce.number().int().optional(),
    until: z.coerce.number().int().optional(),
    action: z.string().max(64).optional(),
    actorUserId: z.string().max(64).optional(),
    projectId: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    /** `nextCursor` of the previous page. */
    cursor: z.string().max(64).optional(),
  }),
  response: z.object({ events: z.array(AdminEventSchema), nextCursor: z.string().nullable() }),
  auth: admin,
});

export const getAdminStorage = defineContract({
  method: "GET",
  path: "/admin/storage",
  response: z.object({
    users: z.array(
      z.object({
        userId: z.string(),
        username: z.string(),
        displayName: z.string(),
        usedBytes: z.number(),
        /** Effective quota; null = unlimited. */
        quotaBytes: z.number().nullable(),
      }),
    ),
    totals: z.object({
      usageBytes: z.number(),
      blobBytes: z.number(),
      blobCount: z.number(),
      diskFreeBytes: z.number().nullable(),
      diskTotalBytes: z.number().nullable(),
    }),
  }),
  auth: admin,
});

export const AdminUploadSchema = z.object({
  versionId: z.string(),
  number: z.number(),
  createdAt: z.number(),
  source: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  songId: z.string(),
  songTitle: z.string(),
  trackId: z.string(),
  trackName: z.string(),
  uploader: z.string().nullable(),
  status: z.string(),
  error: z.string().nullable(),
  filename: z.string(),
  sizeBytes: z.number(),
  deleted: z.boolean(),
});
export type AdminUpload = z.infer<typeof AdminUploadSchema>;

/** Recent track versions (what `status.sh uploads` shows), newest first. */
export const getAdminUploads = defineContract({
  method: "GET",
  path: "/admin/uploads",
  query: z.object({
    hours: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .default(24),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  response: z.object({ uploads: z.array(AdminUploadSchema) }),
  auth: admin,
});

export const LOG_LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

export const AdminLogRecordSchema = z.object({
  source: z.enum(["app", "worker"]),
  time: z.number(),
  level: z.number(),
  msg: z.string(),
  raw: z.record(z.string(), z.unknown()),
});
export type AdminLogRecord = z.infer<typeof AdminLogRecordSchema>;

/** The warn+ log files (SPEC §29.7), oldest first. */
export const getAdminLogs = defineContract({
  method: "GET",
  path: "/admin/logs",
  query: z.object({
    source: z.enum(["app", "worker", "all"]).default("all"),
    level: z.enum(["warn", "error", "fatal"]).default("warn"),
    since: z.coerce.number().int().optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
  }),
  response: z.object({ records: z.array(AdminLogRecordSchema) }),
  auth: admin,
});

// --- Remote updates (SPEC §29.8) -----------------------------------------------------------

export const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/;
export const ReleaseTagSchema = z.string().regex(RELEASE_TAG_RE);

/** Compares `vX.Y.Z` tags numerically (newest first when used in sort). */
export function compareTagsDesc(a: string, b: string): number {
  const pa = a.slice(1).split(".").map(Number);
  const pb = b.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const UpdateRequestSchema = z.object({
  id: z.string(),
  action: z.enum(["deploy", "rollback"]),
  tag: ReleaseTagSchema.nullable(),
  requestedBy: z.string(),
  ts: z.number(),
  /** `pending`: waiting for the host watcher; `running`: deploy.sh is running. */
  state: z.enum(["pending", "running"]),
});
export type UpdateRequest = z.infer<typeof UpdateRequestSchema>;

export const UpdateResultSchema = z.object({
  id: z.string(),
  action: z.string(),
  tag: z.string().nullable(),
  exitCode: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  /** Why the watcher refused the request (invalid request), if it did. */
  error: z.string().nullable(),
  /** The last lines of deploy.sh's output (capped by the watcher). */
  outputTail: z.string(),
});
export type UpdateResult = z.infer<typeof UpdateResultSchema>;

export const UpdatesStateSchema = z.object({
  running: z.string(),
  /** Release tags newest first; null until checked (or the last check failed). */
  available: z.array(ReleaseTagSchema).nullable(),
  checkedAt: z.number().nullable(),
  imageRepo: z.string(),
  request: UpdateRequestSchema.nullable(),
  lastResult: UpdateResultSchema.nullable(),
  /** When the host watcher last wrote its status (null = never: watcher not installed?). */
  hostStatusAt: z.number().nullable(),
});
export type UpdatesState = z.infer<typeof UpdatesStateSchema>;

/**
 * Update state. `check=true` asks the registry for release tags (cached 1 h), `check=force`
 * asks it even when the cache is fresh; without it nothing is fetched.
 */
export const getAdminUpdates = defineContract({
  method: "GET",
  path: "/admin/updates",
  query: z.object({ check: z.enum(["true", "false", "force"]).default("false") }),
  response: UpdatesStateSchema,
  errors: ["UPDATE_CHECK_FAILED"],
  auth: admin,
});

export const requestAdminUpdate = defineContract({
  method: "POST",
  path: "/admin/updates",
  body: z.discriminatedUnion("action", [
    z.object({ action: z.literal("deploy"), tag: ReleaseTagSchema }),
    z.object({ action: z.literal("rollback"), confirmRunningVersion: z.string().min(1).max(64) }),
  ]),
  response: z.object({ request: UpdateRequestSchema }),
  errors: [
    "UPDATE_PENDING",
    "UPDATE_TAG_UNKNOWN",
    "UPDATE_CONFIRM_MISMATCH",
    "UPDATE_CHECK_FAILED",
  ],
  auth: admin,
});

/** Withdraws a request the host watcher has not picked up yet. */
export const cancelAdminUpdate = defineContract({
  method: "DELETE",
  path: "/admin/updates",
  response: z.object({ ok: z.literal(true) }),
  errors: ["NOT_FOUND", "UPDATE_PENDING"],
  auth: admin,
});
