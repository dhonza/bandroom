import { z } from "zod";
import { MixerSnapshotNameSchema, MixerSnapshotSchema, MixerStateSchema } from "../mixer";
import { OkSchema } from "./auth";
import { defineContract } from "./contract";

const IdParams = z.object({ id: z.string().min(1).max(64) });

/** The current user's mixer state and snapshots for a song (SPEC §11.3). */
export const getSongMixer = defineContract({
  method: "GET",
  path: "/songs/:id/mixer",
  params: IdParams,
  response: z.object({
    state: MixerStateSchema.nullable(),
    snapshots: z.array(MixerSnapshotSchema),
  }),
  auth: { capability: "stream", scope: "song" },
});

/** Saves the personal mixer state (debounced by the client; not logged as an event). */
export const putSongMixer = defineContract({
  method: "PUT",
  path: "/songs/:id/mixer",
  params: IdParams,
  body: z.object({ state: MixerStateSchema }),
  response: OkSchema,
  auth: { capability: "stream", scope: "song" },
});

export const createMixerSnapshot = defineContract({
  method: "POST",
  path: "/songs/:id/mixer/snapshots",
  params: IdParams,
  body: z.object({ name: MixerSnapshotNameSchema, state: MixerStateSchema }),
  response: z.object({ snapshot: MixerSnapshotSchema }),
  errors: ["BAD_REQUEST"],
  auth: { capability: "stream", scope: "song" },
});

export const deleteMixerSnapshot = defineContract({
  method: "DELETE",
  path: "/songs/:id/mixer/snapshots/:snapshotId",
  params: z.object({ id: z.string().min(1).max(64), snapshotId: z.string().min(1).max(64) }),
  response: OkSchema,
  errors: ["NOT_FOUND"],
  auth: { capability: "stream", scope: "song" },
});
