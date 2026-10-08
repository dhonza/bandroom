import { z } from "zod";
import { PaletteColorSchema } from "../content";
import {
  VersionGainSchema,
  QueueItemSchema,
  StackVersionSchema,
  TrackNameSchema,
  TrackSchema,
} from "../tracks";
import {
  FormantModeSchema,
  FormantShiftSchema,
  InstrumentSchema,
  VoiceRangeSchema,
} from "../instruments";
import { TRACK_LOCK_FIELDS, VERSION_GAIN_FIELDS } from "../permissions/content";
import { OkSchema } from "./auth";
import { defineContract } from "./contract";

const IdParams = z.object({ id: z.string().min(1).max(64) });

export const listSongTracks = defineContract({
  method: "GET",
  path: "/songs/:id/tracks",
  params: IdParams,
  response: z.object({ tracks: z.array(TrackSchema) }),
  auth: { capability: "view", scope: "song" },
});

/** Soft delete; contributors may delete their own tracks, editors any (checked via canActOn). */
export const deleteTrack = defineContract({
  method: "DELETE",
  path: "/tracks/:id",
  params: IdParams,
  response: OkSchema,
  errors: ["FORBIDDEN"],
  auth: { capability: "delete.own", scope: "track" },
});

/** Re-runs a failed ingest (uploader or editor, SPEC §5.3). */
export const retryTrackVersion = defineContract({
  method: "POST",
  path: "/track-versions/:id/retry",
  params: IdParams,
  response: OkSchema,
  errors: ["FORBIDDEN", "BAD_REQUEST", "LOSSLESS_REMOVED"],
  auth: { capability: "edit.own", scope: "trackVersion" },
});

export const listTrackVersions = defineContract({
  method: "GET",
  path: "/tracks/:id/versions",
  params: IdParams,
  response: z.object({ versions: z.array(StackVersionSchema) }),
  auth: { capability: "view", scope: "track" },
});

/**
 * Label and notes: uploader (contributor+) or editor (SPEC §3.2 edit.own/any). Gain (SPEC §25.6):
 * whoever may edit the track (its creator, or an editor); any finite number of dB.
 */
export const updateTrackVersion = defineContract({
  method: "PATCH",
  path: "/track-versions/:id",
  params: IdParams,
  body: z
    .object({
      label: z.string().trim().max(120),
      notes: z.string().max(5000),
      gainDb: VersionGainSchema,
    })
    .partial(),
  response: OkSchema,
  errors: ["FORBIDDEN", "SONG_LOCKED"],
  auth: { capability: "edit.own", scope: "trackVersion", lockFields: VERSION_GAIN_FIELDS },
});

export const deleteTrackVersion = defineContract({
  method: "DELETE",
  path: "/track-versions/:id",
  params: IdParams,
  response: OkSchema,
  errors: ["FORBIDDEN"],
  auth: { capability: "delete.own", scope: "trackVersion" },
});

/** Makes a version the song's current one for this track (editor action, logged). */
export const setCurrentTrackVersion = defineContract({
  method: "POST",
  path: "/tracks/:id/current",
  params: IdParams,
  body: z.object({ versionId: z.string().min(1).max(64) }),
  response: OkSchema,
  errors: ["NOT_FOUND"],
  auth: { capability: "version.setCurrent", scope: "track" },
});

export const reorderTrackVersions = defineContract({
  method: "PUT",
  path: "/tracks/:id/versions/order",
  params: IdParams,
  body: z.object({ versionIds: z.array(z.string().min(1).max(64)).max(1000) }),
  response: OkSchema,
  auth: { capability: "edit.any", scope: "track" },
});

export const updateTrack = defineContract({
  method: "PATCH",
  path: "/tracks/:id",
  params: IdParams,
  body: z
    .object({
      name: TrackNameSchema,
      color: PaletteColorSchema,
      instrumentTag: z.string().trim().max(40),
      defaultGainDb: z.number().min(-120).max(6),
      defaultPan: z.number().min(-1).max(1),
      defaultMuted: z.boolean(),
      /** null = back to automatic (SPEC §30.3). */
      instrument: InstrumentSchema.nullable(),
      transpose: z.boolean().nullable(),
      voiceRange: VoiceRangeSchema.nullable(),
      formantMode: FormantModeSchema.nullable(),
      formantShift: FormantShiftSchema,
    })
    .partial(),
  response: OkSchema,
  errors: ["FORBIDDEN", "SONG_LOCKED"],
  // The default mix and the playback fields are frozen by a song lock; name and colour stay
  // editable (SPEC §25.12, §30.3).
  auth: { capability: "edit.own", scope: "track", lockFields: TRACK_LOCK_FIELDS },
});

export const reorderSongTracks = defineContract({
  method: "PUT",
  path: "/songs/:id/tracks/order",
  params: IdParams,
  body: z.object({ trackIds: z.array(z.string().min(1).max(64)).max(500) }),
  response: OkSchema,
  auth: { capability: "edit.any", scope: "song" },
});

/** Songs of a project in order, for the engine queue ("Play all", SPEC §6.10, §18.3). */
export const getProjectQueue = defineContract({
  method: "GET",
  path: "/projects/:id/queue",
  params: IdParams,
  response: z.object({ items: z.array(QueueItemSchema) }),
  auth: { capability: "view", scope: "project" },
});
