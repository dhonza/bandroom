import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { songs } from "./content";
import { users } from "./identity";
import { assets } from "./storage";

// Markers & sections (SPEC §4.2, §7.4) and tempo maps (SPEC §4.2, §7.1–§7.3).

/** Points (`marker`) and spans (`section`) on a song's timeline; soft-deleted for undo. */
export const markers = sqliteTable(
  "markers",
  {
    id: text("id").primaryKey(),
    songId: text("song_id")
      .notNull()
      .references(() => songs.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["marker", "section"] }).notNull(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    note: text("note").notNull().default(""),
    startSec: real("start_sec").notNull(),
    /** Sections only. */
    endSec: real("end_sec"),
    anchor: text("anchor", { enum: ["time", "musical"] })
      .notNull()
      .default("time"),
    /** Quarter-note beats from bar 1, set when anchor = musical (M7). */
    startBeat: real("start_beat"),
    endBeat: real("end_beat"),
    /** Sections: stacked lane for overlaps (0 = structure lane). */
    lane: integer("lane").notNull().default(0),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("markers_song_idx").on(t.songId, t.startSec)],
);

/** The song's current tempo map (normalized JSON, SPEC §7.1); one per song. */
export const tempoMaps = sqliteTable("tempo_maps", {
  songId: text("song_id")
    .primaryKey()
    .references(() => songs.id, { onDelete: "cascade" }),
  source: text("source", { enum: ["midi", "manual", "edit"] }).notNull(),
  /** JSON `{ segments }`, validated with Zod on read and write. */
  data: text("data").notNull(),
  /** The imported MIDI file (SPEC §7.2), kept as an asset. */
  midiAssetId: text("midi_asset_id").references(() => assets.id, { onDelete: "set null" }),
  bar1OffsetSec: real("bar1_offset_sec").notNull().default(0),
  /** The revision this state was saved as (comment context `tempoRev`, M8). */
  revisionId: text("revision_id").notNull(),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at").notNull(),
});

/** Every import or edit of a tempo map; any revision can be restored (SPEC §7.2). */
export const tempoMapRevisions = sqliteTable(
  "tempo_map_revisions",
  {
    id: text("id").primaryKey(),
    songId: text("song_id")
      .notNull()
      .references(() => songs.id, { onDelete: "cascade" }),
    source: text("source", { enum: ["midi", "manual", "edit"] }).notNull(),
    data: text("data").notNull(),
    midiAssetId: text("midi_asset_id").references(() => assets.id, { onDelete: "set null" }),
    bar1OffsetSec: real("bar1_offset_sec").notNull().default(0),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("tempo_map_revisions_song_idx").on(t.songId, t.createdAt)],
);
