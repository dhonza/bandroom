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
import { songs } from "./content";
import { users } from "./identity";
import { tracks } from "./tracks";

// Comments (SPEC §4.2; tables from M14 for the importer, UI in M9).

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    songId: text("song_id")
      .notNull()
      .references(() => songs.id, { onDelete: "cascade" }),
    /** Null = song-wide comment. */
    trackId: text("track_id").references(() => tracks.id, { onDelete: "set null" }),
    /** Replies are one level deep. */
    parentId: text("parent_id"),
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    linkId: text("link_id"),
    anonymousName: text("anonymous_name"),
    /** Author of an imported comment with no matching local user, shown as "Name (imported)". */
    importedAuthorName: text("imported_author_name"),
    body: text("body").notNull(),
    /** Null = general comment; endSec null = point comment. */
    startSec: real("start_sec"),
    endSec: real("end_sec"),
    /** JSON `{ trackVersions: { [trackId]: versionId }, tempoRev }` captured at creation. */
    context: text("context").notNull().default("{}"),
    source: text("source", { enum: ["app", "link", "import"] })
      .notNull()
      .default("app"),
    resolvedAt: integer("resolved_at"),
    resolvedBy: text("resolved_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    editedAt: integer("edited_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    index("comments_song_idx").on(t.songId, t.createdAt),
    index("comments_parent_idx").on(t.parentId),
  ],
);

export const commentReactions = sqliteTable(
  "comment_reactions",
  {
    id: text("id").primaryKey(),
    commentId: text("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    /** Exactly one of userId / linkSessionId is set. */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    linkSessionId: text("link_session_id"),
    emoji: text("emoji").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("comment_reactions_user_idx")
      .on(t.commentId, t.userId, t.emoji)
      .where(sql`${t.userId} IS NOT NULL`),
  ],
);

/** `@username` mentions of a comment (SPEC §4.2, §8); only users who can view the song. */
export const commentMentions = sqliteTable(
  "comment_mentions",
  {
    commentId: text("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.commentId, t.userId] }),
    index("comment_mentions_user_idx").on(t.userId),
  ],
);
