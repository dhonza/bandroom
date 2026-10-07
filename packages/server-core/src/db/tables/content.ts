import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./identity";

// Content (SPEC §4.2): projects, songs and their grants.

const CONTENT_ROLE_ENUM = [
  "none",
  "viewer",
  "commenter",
  "contributor",
  "editor",
  "manager",
] as const;

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Project image (M3, via image.ingest). */
    imageAssetId: text("image_asset_id"),
    color: text("color").notNull().default("violet"),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    downloadPolicy: text("download_policy", { enum: ["all", "contributors", "editors"] })
      .notNull()
      .default("all"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    archivedAt: integer("archived_at"),
    deletedAt: integer("deleted_at"),
    /** Who moved it to the Trash (SPEC §26.3). */
    deletedBy: text("deleted_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("projects_deleted_idx").on(t.deletedAt)],
);

export const projectGrants = sqliteTable(
  "project_grants",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: CONTENT_ROLE_ENUM }).notNull(),
    grantedBy: text("granted_by").references(() => users.id, { onDelete: "set null" }),
    grantedAt: integer("granted_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index("project_grants_user_idx").on(t.userId),
  ],
);

export const songs = sqliteTable(
  "songs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    subtitle: text("subtitle").notNull().default(""),
    notes: text("notes").notNull().default(""),
    /** Musical key, free text. */
    key: text("key").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    downloadPolicy: text("download_policy", { enum: ["inherit", "all", "contributors", "editors"] })
      .notNull()
      .default("inherit"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
    /** Who moved the song to the Trash (SPEC §26.3). */
    deletedBy: text("deleted_by").references(() => users.id, { onDelete: "set null" }),
    /** Bumped on tempo/marker changes for cache invalidation (M6/M7). */
    timelineRev: integer("timeline_rev").notNull().default(0),
    /** Song lock (SPEC §25.12): set while locked; markers, comments, default mix… are frozen. */
    lockedAt: integer("locked_at"),
    lockedBy: text("locked_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("songs_project_idx").on(t.projectId, t.sortOrder)],
);

export const songGrants = sqliteTable(
  "song_grants",
  {
    songId: text("song_id")
      .notNull()
      .references(() => songs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: CONTENT_ROLE_ENUM }).notNull(),
    grantedBy: text("granted_by").references(() => users.id, { onDelete: "set null" }),
    grantedAt: integer("granted_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.songId, t.userId] }),
    index("song_grants_user_idx").on(t.userId),
  ],
);
