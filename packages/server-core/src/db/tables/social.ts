import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects, songs } from "./content";
import { users } from "./identity";

// Notifications and follows (SPEC §4.2, §4.4, §16).

/** In-app notifications (no email, DECISIONS "No email"); `payload` is JSON. */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: text("payload").notNull().default("{}"),
    /** For filtering and cleanup; null for instance-level notifications (reset requests). */
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    songId: text("song_id").references(() => songs.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    readAt: integer("read_at"),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

/** Users follow projects and songs (SPEC §4.4, §16). */
export const follows = sqliteTable(
  "follows",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetType: text("target_type", { enum: ["project", "song"] }).notNull(),
    targetId: text("target_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.targetType, t.targetId] }),
    index("follows_target_idx").on(t.targetType, t.targetId),
  ],
);
