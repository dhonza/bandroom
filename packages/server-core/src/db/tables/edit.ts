import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects, songs } from "./content";
import { users } from "./identity";

// Edit mode (SPEC §24.2): one session per editing of a song. Renders come with M18.

export const editSessions = sqliteTable(
  "edit_sessions",
  {
    id: text("id").primaryKey(),
    songId: text("song_id")
      .notNull()
      .references(() => songs.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["open", "applying", "done", "cancelled", "failed"],
    }).notNull(),
    /** The editor holding the session; changes on takeover. */
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    /** When the owner got the session (start or takeover). */
    ownerSince: integer("owner_since").notNull(),
    /** JSON `EditBase`, validated with Zod on read. */
    base: text("base").notNull(),
    /** JSON `EditOp[]`. */
    ops: text("ops").notNull().default("[]"),
    /** Number of applied ops (the undo cursor). */
    cursor: integer("cursor").notNull().default(0),
    /** JSON `EditOptions`. */
    options: text("options").notNull(),
    /** +1 per save (optimistic concurrency). */
    rev: integer("rev").notNull().default(0),
    /** JSON outcome of Apply/Bounce (M18). */
    outcome: text("outcome"),
    /** The last `edit.session_saved` event (they are throttled to one per minute). */
    saveLoggedAt: integer("save_logged_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    finishedAt: integer("finished_at"),
    error: text("error"),
  },
  (t) => [
    index("edit_sessions_song_idx").on(t.songId, t.createdAt),
    // At most one session holds the song (SPEC §24.2).
    uniqueIndex("edit_sessions_active_idx")
      .on(t.songId)
      .where(sql`${t.status} IN ('open', 'applying')`),
  ],
);
