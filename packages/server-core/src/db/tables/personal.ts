import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects, songs } from "./content";
import { users } from "./identity";

// Per-user state: mixer states and snapshots, song visits, project stars (SPEC §4.4).

/** Personal mixer state per user per song (SPEC §4.4, §11.3); `state` is JSON. */
export const mixerStates = sqliteTable(
  "mixer_states",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    songId: text("song_id")
      .notNull()
      .references(() => songs.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.songId] })],
);

/** Named mixer snapshots ("Me practising bass"), per user per song (SPEC §4.4). */
export const mixerSnapshots = sqliteTable(
  "mixer_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    songId: text("song_id")
      .notNull()
      .references(() => songs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    state: text("state").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("mixer_snapshots_user_song_idx").on(t.userId, t.songId)],
);

/** Last visit per user and song: the "What's new" banner (SPEC §4.4, §11.3). */
export const songVisits = sqliteTable(
  "song_visits",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    songId: text("song_id")
      .notNull()
      .references(() => songs.id, { onDelete: "cascade" }),
    lastVisitedAt: integer("last_visited_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.songId] })],
);

/**
 * Per-user project state for the Library (SPEC §11): the favourite star (pinned first) and when the
 * user last opened the project, one of its songs or its play queue. Reads, so no events for access.
 */
export const projectUserState = sqliteTable(
  "project_user_state",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** When the user starred the project; null: not starred. */
    starredAt: integer("starred_at"),
    /** Last time the user opened the project, one of its songs or its queue; null: never. */
    lastAccessedAt: integer("last_accessed_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId] })],
);
