import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./identity";

// Storage & processing (SPEC §4.3).

/** Content-addressed, immutable files. Deleted by GC when unreferenced for 24 h. */
export const blobs = sqliteTable(
  "blobs",
  {
    hash: text("hash").primaryKey(),
    sizeBytes: integer("size_bytes").notNull(),
    backend: text("backend", { enum: ["local", "s3"] })
      .notNull()
      .default("local"),
    storageKey: text("storage_key").notNull(),
    refCount: integer("ref_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    /** When refCount last dropped to 0 (GC grace period starts). */
    unreferencedAt: integer("unreferenced_at"),
  },
  (t) => [index("blobs_gc_idx").on(t.refCount, t.unreferencedAt)],
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["audio", "document", "image", "midi"] }).notNull(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull().default("application/octet-stream"),
    sizeBytes: integer("size_bytes").notNull(),
    originalHash: text("original_hash").notNull(),
    status: text("status", {
      enum: ["uploading", "queued", "processing", "ready", "failed"],
    }).notNull(),
    error: text("error"),
    /** JSON (SPEC §5.3), validated with Zod. */
    probe: text("probe"),
    /** JSON upload options (SPEC §28.2: lossy only, Opus preset); null = defaults. */
    ingestOptions: text("ingest_options"),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("assets_uploader_idx").on(t.uploadedBy)],
);

export const assetVariants = sqliteTable(
  "asset_variants",
  {
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    variant: text("variant").notNull(),
    blobHash: text("blob_hash")
      .notNull()
      .references(() => blobs.hash),
    /** JSON: codec, bitrate, sampleRate, channels, durationSamples, preSkip, … */
    meta: text("meta").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.assetId, t.variant] }),
    index("asset_variants_blob_idx").on(t.blobHash),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    status: text("status", {
      enum: ["queued", "running", "done", "failed", "cancelled"],
    }).notNull(),
    priority: integer("priority").notNull().default(0),
    capability: text("capability").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedBy: text("locked_by"),
    lockedUntil: integer("locked_until"),
    /** Earliest time a queued job may run (retry backoff). */
    runAfter: integer("run_after").notNull().default(0),
    progress: real("progress").notNull().default(0),
    result: text("result"),
    error: text("error"),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    dedupeKey: text("dedupe_key"),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.capability, t.priority, t.createdAt),
    // Unique while queued/running (SPEC §4.3).
    uniqueIndex("jobs_dedupe_active_idx")
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL AND ${t.status} IN ('queued', 'running')`),
  ],
);

export const workers = sqliteTable("workers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["local", "remote"] }).notNull(),
  tokenHash: text("token_hash"),
  capabilities: text("capabilities").notNull().default("[]"),
  lastSeenAt: integer("last_seen_at"),
  version: text("version"),
});

export const uploadSessions = sqliteTable("upload_sessions", {
  /** tus upload id. */
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  targetType: text("target_type").notNull(),
  /** JSON target (SPEC §5.1). */
  target: text("target").notNull(),
  filename: text("filename").notNull(),
  declaredSize: integer("declared_size").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  completedAt: integer("completed_at"),
});

/** Storage used per uploader, maintained incrementally (SPEC §15.1). `system` for versions without an uploader (pre-M21 auto-mixes). */
export const userUsage = sqliteTable("user_usage", {
  userId: text("user_id").primaryKey(),
  bytes: integer("bytes").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});
