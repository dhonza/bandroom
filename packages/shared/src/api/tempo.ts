import { z } from "zod";
import { MAX_MIDI_BYTES, MAX_MIDI_MARKERS } from "../tempo/midi";
import { Bar1OffsetSchema, TempoMapDataSchema, TempoMapSchema } from "../tempo/model";
import { OkSchema } from "./auth";
import { defineContract } from "./contract";

const IdParams = z.object({ id: z.string().min(1).max(64) });

export const TEMPO_SOURCES = ["midi", "manual"] as const;
export const TempoSourceSchema = z.enum(TEMPO_SOURCES);
export type TempoSource = z.infer<typeof TempoSourceSchema>;

/** A song's current tempo map (SPEC §4.2 `tempo_maps`). */
export const SongTempoSchema = z.object({
  map: TempoMapDataSchema,
  bar1OffsetSec: z.number(),
  source: TempoSourceSchema,
  /** File name of the imported MIDI (when the map came from one). */
  midiFileName: z.string().nullable(),
  revisionId: z.string(),
  updatedByName: z.string().nullable(),
  updatedAt: z.number(),
});
export type SongTempo = z.infer<typeof SongTempoSchema>;

export const TempoRevisionSchema = z.object({
  id: z.string(),
  map: TempoMapDataSchema,
  bar1OffsetSec: z.number(),
  source: TempoSourceSchema,
  midiFileName: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.number(),
});
export type TempoRevision = z.infer<typeof TempoRevisionSchema>;

/** The song's tempo map, or null without one (click, count-in and grid are then off). */
export const getSongTempo = defineContract({
  method: "GET",
  path: "/songs/:id/tempo",
  params: IdParams,
  response: z.object({ tempo: SongTempoSchema.nullable(), timelineRev: z.number() }),
  auth: { capability: "view", scope: "song" },
});

/**
 * Manual tempo (SPEC §7.3): the map and the bar 1 offset. Musical markers move with it; a new
 * revision is recorded.
 */
export const putSongTempo = defineContract({
  method: "PUT",
  path: "/songs/:id/tempo",
  params: IdParams,
  body: z.object({ map: TempoMapSchema, bar1OffsetSec: Bar1OffsetSchema }),
  response: z.object({ tempo: SongTempoSchema }),
  errors: ["VALIDATION_FAILED"],
  auth: { capability: "tempo.edit", scope: "song" },
});

/** Base64 of at most 1 MB. */
const MidiDataSchema = z
  .string()
  .max(Math.ceil(MAX_MIDI_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

/**
 * MIDI import (SPEC §7.2): the server parses the file again, stores it as an asset, replaces the
 * tempo map and creates the markers picked by index (`markers` of the client-side parse, which
 * uses the same parser).
 */
export const importSongTempoMidi = defineContract({
  method: "POST",
  path: "/songs/:id/tempo/midi",
  params: IdParams,
  body: z.object({
    fileName: z.string().trim().min(1).max(255),
    data: MidiDataSchema,
    markers: z
      .array(
        z
          .number()
          .int()
          .min(0)
          .max(MAX_MIDI_MARKERS - 1),
      )
      .max(MAX_MIDI_MARKERS),
  }),
  response: z.object({ tempo: SongTempoSchema, markersCreated: z.number() }),
  errors: ["MIDI_INVALID", "MIDI_SMPTE", "MIDI_FORMAT", "FILE_TOO_LARGE"],
  auth: { capability: "tempo.edit", scope: "song" },
});

/** Removes the tempo map; musical markers keep their times and become time-anchored. */
export const deleteSongTempo = defineContract({
  method: "DELETE",
  path: "/songs/:id/tempo",
  params: IdParams,
  response: OkSchema,
  auth: { capability: "tempo.edit", scope: "song" },
});

/** Tempo history, newest first (SPEC §7.2 history dialog). */
export const listTempoRevisions = defineContract({
  method: "GET",
  path: "/songs/:id/tempo/revisions",
  params: IdParams,
  response: z.object({ revisions: z.array(TempoRevisionSchema) }),
  auth: { capability: "view", scope: "song" },
});

/** Makes an older revision the current tempo map (recorded as a new revision). */
export const restoreTempoRevision = defineContract({
  method: "POST",
  path: "/songs/:id/tempo/revisions/:revisionId/restore",
  params: z.object({ id: z.string().min(1).max(64), revisionId: z.string().min(1).max(64) }),
  response: z.object({ tempo: SongTempoSchema }),
  errors: ["NOT_FOUND"],
  auth: { capability: "tempo.edit", scope: "song" },
});
