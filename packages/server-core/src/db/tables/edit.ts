import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects, songs } from "./content";
import { users } from "./identity";

// Edit mode (SPEC §24.2): one session per editing of a song, one render per output of an
// Apply/Bounce.

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

export const editRenders = sqliteTable(
  "edit_renders",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => editSessions.id, { onDelete: "cascade" }),
    /** `<trackId>`, or `<rangeId>:<trackId>` for split into songs. Unique per session. */
    outputKey: text("output_key").notNull(),
    /** The edited (source) track. */
    trackId: text("track_id").notNull(),
    /** Split into songs: the range (its id) and its index in timeline order. */
    rangeId: text("range_id"),
    rangeIndex: integer("range_index"),
    /** The output track's name and (split into songs) the new song's title. */
    title: text("title").notNull(),
    songTitle: text("song_title"),
    /** Track and song the commit put the version into (new tracks/songs); null before. */
    targetTrackId: text("target_track_id"),
    targetSongId: text("target_song_id"),
    /** The hidden version (`track_versions.edit_session_id` set) and its asset. */
    versionId: text("version_id"),
    assetId: text("asset_id"),
    status: text("status", { enum: ["queued", "running", "done", "failed", "skipped"] }).notNull(),
    /** JSON `EditClip[]` of this output, frozen when Apply/Bounce was requested. */
    clips: text("clips").notNull(),
    /** Timeline position of the output (its first clip) and its length, 48 kHz frames. */
    offsetSamples: integer("offset_samples").notNull(),
    lengthFrames: integer("length_frames").notNull(),
    /** Whether any clip's source is lossy (the render is marked `derivedFromLossy`). */
    lossySource: integer("lossy_source", { mode: "boolean" }).notNull().default(false),
    /** True peak of the render, dBTP. */
    peakDb: real("peak_db"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("edit_renders_output_idx").on(t.sessionId, t.outputKey),
    index("edit_renders_asset_idx").on(t.assetId),
  ],
);
