import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { songs } from "./content";
import { users } from "./identity";
import { assets } from "./storage";

// Tracks (SPEC §4.2; UI in M4).

export const tracks = sqliteTable(
  "tracks",
  {
    id: text("id").primaryKey(),
    songId: text("song_id")
      .notNull()
      .references(() => songs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("blue"),
    sortOrder: integer("sort_order").notNull().default(0),
    currentVersionId: text("current_version_id"),
    defaultGainDb: real("default_gain_db").notNull().default(0),
    defaultPan: real("default_pan").notNull().default(0),
    defaultMuted: integer("default_muted", { mode: "boolean" }).notNull().default(false),
    /** Free text, e.g. "bass"; used by "mute my instrument" (M5). */
    instrumentTag: text("instrument_tag").notNull().default(""),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
    /** Who moved the track to the Trash (SPEC §26.3). */
    deletedBy: text("deleted_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("tracks_song_idx").on(t.songId, t.sortOrder)],
);

export const trackVersions = sqliteTable(
  "track_versions",
  {
    id: text("id").primaryKey(),
    trackId: text("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    /** 1-based per track, stable ("v3" never changes meaning). */
    number: integer("number").notNull(),
    stackOrder: integer("stack_order").notNull().default(0),
    label: text("label").notNull().default(""),
    notes: text("notes").notNull().default(""),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id),
    /** Timeline position in samples at 48 kHz (SPEC §6.5). */
    offsetSamples: integer("offset_samples").notNull().default(0),
    /** Gain of this version in dB, before the fader and pan (SPEC §25.6); any finite number. */
    gainDb: real("gain_db").notNull().default(0),
    source: text("source", { enum: ["upload", "recording", "import", "render"] }).notNull(),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
    /** Who moved the version to the Trash (SPEC §26.3). */
    deletedBy: text("deleted_by").references(() => users.id, { onDelete: "set null" }),
    /** Full-quality files removed (SPEC §15.3, §26.4): no flac, original or wavmeta variants. */
    archivedAt: integer("archived_at"),
    /** Who removed them (SPEC §26.4). */
    archivedBy: text("archived_by").references(() => users.id, { onDelete: "set null" }),
    /** Why (SPEC §28.2–28.3): "removed", "upload" or "reencode"; null for older rows = removed. */
    archivedReason: text("archived_reason", { enum: ["removed", "upload", "reencode"] }),
  },
  (t) => [
    index("track_versions_track_idx").on(t.trackId, t.number),
    index("track_versions_asset_idx").on(t.assetId),
  ],
);
