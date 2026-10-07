import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./identity";

// Instance settings, the activity log (SPEC §14.1) and idempotent client requests.

/**
 * Instance settings (SPEC §4.1). Values are JSON, validated with Zod on read and write
 * (see `settings/registry.ts`). Timestamps are epoch milliseconds.
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  /** JSON-encoded; (de)serialized by the settings registry so `null` stays a JSON value. */
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Append-only activity log. There is intentionally no update path in the code. */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    ts: integer("ts").notNull(),
    actorType: text("actor_type", { enum: ["user", "link", "system", "worker"] }).notNull(),
    actorUserId: text("actor_user_id"),
    linkId: text("link_id"),
    linkSessionId: text("link_session_id"),
    sessionId: text("session_id"),
    action: text("action").notNull(),
    projectId: text("project_id"),
    songId: text("song_id"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    /** Nulled after `retention.ipDays` (M13). */
    ip: text("ip"),
    userAgent: text("user_agent"),
    details: text("details"),
  },
  (t) => [
    index("events_ts_idx").on(t.ts),
    index("events_project_ts_idx").on(t.projectId, t.ts),
    index("events_actor_ts_idx").on(t.actorUserId, t.ts),
    index("events_link_ts_idx").on(t.linkId, t.ts),
  ],
);

/** Idempotent mutations by client `requestId` (SPEC §4.4, §18.3); purged after 7 days. */
export const clientRequests = sqliteTable(
  "client_requests",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    route: text("route").notNull(),
    /** JSON response returned again on a replay. */
    response: text("response").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.requestId] }),
    index("client_requests_created_idx").on(t.createdAt),
  ],
);
