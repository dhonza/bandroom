import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./identity";

// Imports (SPEC §17).

export const importRuns = sqliteTable(
  "import_runs",
  {
    id: text("id").primaryKey(),
    source: text("source", { enum: ["samply"] }).notNull(),
    status: text("status", {
      enum: ["connected", "scanning", "review", "running", "done", "failed", "cancelled"],
    }).notNull(),
    dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(false),
    /** AES-GCM with the app secret; cleared when the run finishes or is cancelled. */
    secretEnc: text("secret_enc"),
    /** JSON: selected external project ids. */
    selection: text("selection").notNull().default("[]"),
    /** JSON: the proposed/edited mapping tree (review step). */
    mapping: text("mapping"),
    /** JSON: imported / skipped / failed items and users to invite. */
    report: text("report"),
    progress: real("progress").notNull().default(0),
    error: text("error"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("import_runs_created_idx").on(t.createdAt)],
);

/** External id → local entity; makes re-runs idempotent and enables "new items only". */
export const importMap = sqliteTable(
  "import_map",
  {
    source: text("source", { enum: ["samply"] }).notNull(),
    externalType: text("external_type").notNull(),
    externalId: text("external_id").notNull(),
    localType: text("local_type").notNull(),
    localId: text("local_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => importRuns.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.externalType, t.externalId, t.localType] }),
    index("import_map_local_idx").on(t.localType, t.localId),
  ],
);
