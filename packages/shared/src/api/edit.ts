import { z } from "zod";
import {
  DEFAULT_EDIT_FADES,
  EditBaseSchema,
  EditOpSchema,
  EditOptionsSchema,
  FOLLOW_ALL,
  MAX_EDIT_OPS,
  type EditOptions,
} from "../edit/schema";
import { defineContract } from "./contract";

/**
 * Edit sessions (SPEC §24.7, §24.11). One open session per song holds the edit lock; only its
 * owner saves, any other editor may take it over or cancel it. Apply and Bounce come with M18.
 */

export const EDIT_SESSION_STATUSES = ["open", "applying", "done", "cancelled", "failed"] as const;
export const EditSessionStatusSchema = z.enum(EDIT_SESSION_STATUSES);
export type EditSessionStatus = z.infer<typeof EditSessionStatusSchema>;

/** Statuses that hold the edit lock. */
export const ACTIVE_EDIT_SESSION_STATUSES = ["open", "applying"] as const;

/** Options of a new session (SPEC §24.6): 10 ms fades, both play, everything follows. */
export const DEFAULT_EDIT_OPTIONS: EditOptions = {
  fades: DEFAULT_EDIT_FADES,
  overlap: "mix",
  timeline: FOLLOW_ALL,
  snap: "markers",
};

/**
 * Ops a save may carry: the server keeps at most {@link MAX_EDIT_OPS} (older ones are folded into
 * the base), the rest is room for the ops made since the last save.
 */
export const MAX_SAVED_EDIT_OPS = MAX_EDIT_OPS * 2;
/** Body limit of a save (bytes): 4 000 large ops stay well below it. */
export const EDIT_SAVE_BODY_LIMIT = 8 * 1024 * 1024;

/**
 * An edit session. Everyone who sees the song gets id, status, owner and since; the owner also
 * gets the editing state (`base`, `ops`, `cursor`, `options`, `rev`), which others never see.
 */
export const EditSessionSchema = z.object({
  id: z.string(),
  songId: z.string(),
  status: EditSessionStatusSchema,
  /** The editor holding the session (changes on takeover). */
  owner: z.object({ id: z.string(), name: z.string() }),
  /** When the owner got the session (start or takeover), epoch ms. */
  since: z.number(),
  updatedAt: z.number(),
  /** The tracks and versions when the session started, plus folded ops (owner only). */
  base: EditBaseSchema.optional(),
  ops: z.array(EditOpSchema).optional(),
  /** Number of applied ops; the ops after it are the redo tail. */
  cursor: z.number().int().min(0).optional(),
  options: EditOptionsSchema.optional(),
  /** +1 per save; a save names the rev it builds on (optimistic concurrency). */
  rev: z.number().int().min(0).optional(),
});
export type EditSession = z.infer<typeof EditSessionSchema>;

const SongParams = z.object({ id: z.string().min(1).max(64) });
const SessionParams = z.object({ id: z.string().min(1).max(64) });
const SessionResponse = z.object({ session: EditSessionSchema });

/**
 * Starts a session on the song (SPEC §24.7): the base is the current, ready versions of its
 * tracks. Refused while another session is open (`EDIT_SESSION_OPEN`), while the song is locked
 * (`SONG_LOCKED`) and while a current version is still processing (`PROCESSING_SOURCE`).
 */
export const startEditSession = defineContract({
  method: "POST",
  path: "/songs/:id/edit-session",
  params: SongParams,
  response: SessionResponse,
  errors: [
    "FORBIDDEN",
    "EDIT_SESSION_OPEN",
    "SONG_LOCKED",
    "PROCESSING_SOURCE",
    "VALIDATION_FAILED",
  ],
  auth: { capability: "audio.edit", scope: "song" },
});

/** The song's open (or applying) session, or null; others than the owner get the summary. */
export const getEditSession = defineContract({
  method: "GET",
  path: "/songs/:id/edit-session",
  params: SongParams,
  response: z.object({ session: EditSessionSchema.nullable() }),
  errors: ["NOT_FOUND"],
  auth: { capability: "view", scope: "song" },
});

export const SaveEditSessionSchema = z
  .object({
    /** The rev the client's state builds on. */
    rev: z.number().int().min(0),
    ops: z.array(EditOpSchema).max(MAX_SAVED_EDIT_OPS),
    cursor: z.number().int().min(0),
    options: EditOptionsSchema,
  })
  .refine((b) => b.cursor <= b.ops.length, {
    message: "The cursor is past the last op",
    path: ["cursor"],
  });
export type SaveEditSession = z.infer<typeof SaveEditSessionSchema>;

/**
 * Autosave (SPEC §24.7): the whole op list, the cursor and the options. `EDIT_CONFLICT` when the
 * rev is not the server's (reload), `VALIDATION_FAILED` when a new op does not apply (params
 * `index`, `reason`). Over {@link MAX_EDIT_OPS} ops the oldest are folded into the base, so the
 * answer may have a new base and fewer ops: the client continues from it.
 */
export const saveEditSession = defineContract({
  method: "PUT",
  path: "/edit-sessions/:id",
  params: SessionParams,
  body: SaveEditSessionSchema,
  response: SessionResponse,
  errors: [
    "FORBIDDEN",
    "EDIT_CONFLICT",
    "EDIT_SESSION_STATE",
    "NOT_SESSION_OWNER",
    "VALIDATION_FAILED",
  ],
  auth: { capability: "audio.edit", scope: "editSession" },
});

/** Another editor takes the session over; nothing is lost (SPEC §24.7). */
export const takeOverEditSession = defineContract({
  method: "POST",
  path: "/edit-sessions/:id/take-over",
  params: SessionParams,
  response: SessionResponse,
  errors: ["FORBIDDEN", "EDIT_SESSION_STATE"],
  auth: { capability: "audio.edit", scope: "editSession" },
});

/** Ends the session without changes and releases the lock; the owner or any other editor. */
export const cancelEditSession = defineContract({
  method: "POST",
  path: "/edit-sessions/:id/cancel",
  params: SessionParams,
  response: SessionResponse,
  errors: ["FORBIDDEN", "EDIT_SESSION_STATE"],
  auth: { capability: "audio.edit", scope: "editSession" },
});
