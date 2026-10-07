import { z } from "zod";
import { CreateMarkerSchema, MarkerSchema, UpdateMarkerSchema, WhatsNewSchema } from "../markers";
import { OkSchema } from "./auth";
import { defineContract } from "./contract";

const IdParams = z.object({ id: z.string().min(1).max(64) });

/** Markers and sections of a song (SPEC §7.4), with the song's timeline revision. */
export const listSongMarkers = defineContract({
  method: "GET",
  path: "/songs/:id/markers",
  params: IdParams,
  response: z.object({ markers: z.array(MarkerSchema), timelineRev: z.number() }),
  auth: { capability: "view", scope: "song" },
});

/** Contributors create markers and sections (SPEC §3.2 `annotate.own`). */
export const createMarker = defineContract({
  method: "POST",
  path: "/songs/:id/markers",
  params: IdParams,
  body: CreateMarkerSchema,
  response: z.object({ marker: MarkerSchema }),
  errors: ["BAD_REQUEST"],
  auth: { capability: "annotate.own", scope: "song" },
});

/** Own items with `annotate.own`, anyone's with `annotate.any` (checked via canActOn). */
export const updateMarker = defineContract({
  method: "PATCH",
  path: "/markers/:id",
  params: IdParams,
  body: UpdateMarkerSchema,
  response: z.object({ marker: MarkerSchema }),
  errors: ["NOT_FOUND", "BAD_REQUEST", "FORBIDDEN"],
  auth: { capability: "annotate.own", scope: "marker" },
});

/** Soft delete; the client offers undo for 8 s (SPEC §11.1). */
export const deleteMarker = defineContract({
  method: "DELETE",
  path: "/markers/:id",
  params: IdParams,
  response: OkSchema,
  errors: ["NOT_FOUND", "FORBIDDEN"],
  auth: { capability: "annotate.own", scope: "marker" },
});

/** Undo of a delete. */
export const restoreMarker = defineContract({
  method: "POST",
  path: "/markers/:id/restore",
  params: IdParams,
  response: z.object({ marker: MarkerSchema }),
  errors: ["NOT_FOUND", "FORBIDDEN"],
  auth: { capability: "annotate.own", scope: "marker" },
});

/** What changed since the user's previous visit (SPEC §11.3 banner); read only. */
export const getSongWhatsNew = defineContract({
  method: "GET",
  path: "/songs/:id/whats-new",
  params: IdParams,
  response: WhatsNewSchema,
  auth: { capability: "view", scope: "song" },
});

/** Records the visit (drives the banner and "new since last visit"); not an activity event. */
export const recordSongVisit = defineContract({
  method: "PUT",
  path: "/songs/:id/visit",
  params: IdParams,
  response: OkSchema,
  auth: { capability: "view", scope: "song" },
});
