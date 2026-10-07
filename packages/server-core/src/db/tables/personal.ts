import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { songs } from "./content";
import { users } from "./identity";

// Per-user state: mixer states and snapshots, song visits (SPEC §4.4).

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
