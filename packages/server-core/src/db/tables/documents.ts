import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects, songs } from "./content";
import { users } from "./identity";
import { assets } from "./storage";

// Documents (SPEC §4.2; tables from M14 for the importer, UI in M8).

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Null = project-level document. */
    songId: text("song_id").references(() => songs.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    kind: text("kind", { enum: ["markdown", "text", "pdf", "image", "midi", "other"] }).notNull(),
    currentVersionId: text("current_version_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
    /** Who moved it to the Trash (SPEC §26.3). */
    deletedBy: text("deleted_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("documents_project_idx").on(t.projectId, t.sortOrder),
    index("documents_song_idx").on(t.songId, t.sortOrder),
  ],
);

export const documentVersions = sqliteTable(
  "document_versions",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id),
    notes: text("notes").notNull().default(""),
    source: text("source", { enum: ["upload", "import", "edit"] })
      .notNull()
      .default("upload"),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    /** Soft delete (undo, SPEC §11.1); blobs stay until the trash purge (M13). */
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    index("document_versions_doc_idx").on(t.documentId, t.number),
    index("document_versions_asset_idx").on(t.assetId),
  ],
);
