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
import { EditSongNamingSchema, EditSongRangeSchema } from "../edit/songs";
import { SongTitleSchema } from "../content";
import { defineContract } from "./contract";

/**
 * Edit sessions (SPEC §24.7, §24.11). One open session per song holds the edit lock; only its
 * owner saves, any other editor may take it over or cancel it. Apply and Bounce render the edit
 * in the worker and commit it atomically (SPEC §24.8–§24.10, §24.14).
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

/** How a session ends (SPEC §24.8, §24.9). */
export const EDIT_OUTCOME_KINDS = [
  "apply",
  "bounceVersions",
  "bounceTracks",
  "bounceSongs",
] as const;
export const EditOutcomeKindSchema = z.enum(EDIT_OUTCOME_KINDS);
export type EditOutcomeKind = z.infer<typeof EditOutcomeKindSchema>;

export const EDIT_RENDER_STATUSES = ["queued", "running", "done", "failed", "skipped"] as const;
export const EditRenderStatusSchema = z.enum(EDIT_RENDER_STATUSES);
export type EditRenderStatus = z.infer<typeof EditRenderStatusSchema>;

/**
 * One output of an Apply/Bounce (SPEC §24.2 `edit_renders`): its render, then the normal ingest
 * of the rendered file. `phase` says where it is; `progress` is 0…1 over both.
 */
export const EditRenderProgressSchema = z.object({
  id: z.string(),
  /** The edited track it renders (the source track for new tracks and songs). */
  trackId: z.string(),
  /** Split into songs: the range it belongs to. */
  rangeId: z.string().nullable(),
  status: EditRenderStatusSchema,
  phase: z.enum(["render", "ingest", "ready", "failed"]),
  progress: z.number().min(0).max(1),
  /** True peak of the render (dBTP), once rendered. */
  peakDb: z.number().nullable(),
  error: z.string().nullable(),
});
export type EditRenderProgress = z.infer<typeof EditRenderProgressSchema>;

/** What an Apply/Bounce was asked to do (stored on the session while it runs). */
export const EditOutcomeSchema = z.object({
  kind: EditOutcomeKindSchema,
  /** Who applied (owns the new files). */
  by: z.string(),
  at: z.number(),
  keepEditing: z.boolean(),
  /** After the commit: what was created. */
  versionIds: z.array(z.string()).optional(),
  trackIds: z.array(z.string()).optional(),
  songIds: z.array(z.string()).optional(),
});
export type EditOutcome = z.infer<typeof EditOutcomeSchema>;

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
  /** The running or last Apply/Bounce (M18); null when none. */
  outcome: EditOutcomeSchema.nullable().optional(),
  /** Its renders with their progress (empty when none). */
  renders: z.array(EditRenderProgressSchema).optional(),
  /** Why the last Apply/Bounce failed (the session is `open` again); null otherwise. */
  error: z.string().nullable().optional(),
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

/**
 * Ends the session without changes and releases the lock; the owner or any other editor. While
 * `applying` (SPEC §24.14): queued renders are skipped, the running one is discarded, the hidden
 * versions are purged.
 */
export const cancelEditSession = defineContract({
  method: "POST",
  path: "/edit-sessions/:id/cancel",
  params: SessionParams,
  response: SessionResponse,
  errors: ["FORBIDDEN", "EDIT_SESSION_STATE"],
  auth: { capability: "audio.edit", scope: "editSession" },
});

// ——— Apply & Bounce (M18) ————————————————————————————————————————————————————————————————

/** Warnings of the review (SPEC §24.8). */
export const EDIT_REVIEW_WARNINGS = [
  /** A clip's source has no full quality (a lossy upload): the render is marked lossy-derived. */
  "LOSSY_SOURCE",
  /** A clip's source had its full quality removed: the render reads the Opus. */
  "ARCHIVED_SOURCE",
  /** Clips of one output come from files with different sample rates (resampled to 48 kHz). */
  "MIXED_SAMPLE_RATES",
  /** A ripple on a subset of tracks left them out of sync with the others. */
  "OUT_OF_SYNC",
  /** The estimated peak of an output is above 0 dBFS (renders have no limiter). */
  "PEAK_OVER_0DBFS",
] as const;
export const EditReviewWarningCodeSchema = z.enum(EDIT_REVIEW_WARNINGS);
export type EditReviewWarningCode = z.infer<typeof EditReviewWarningCodeSchema>;

export const EditReviewWarningSchema = z.object({
  code: EditReviewWarningCodeSchema,
  /** The tracks it concerns (source track ids). */
  trackIds: z.array(z.string()),
});
export type EditReviewWarning = z.infer<typeof EditReviewWarningSchema>;

/** One file the Apply/Bounce will render. */
export const EditReviewOutputSchema = z.object({
  /** `<trackId>` or `<rangeId>:<trackId>` (split into songs). */
  key: z.string(),
  trackId: z.string(),
  /** The source track's name. */
  trackName: z.string(),
  /** Name of the output track (`<track> (edit)`, `Intro – Guitar`, or the track's name). */
  title: z.string(),
  /** Split into songs: the range and its song title. */
  rangeId: z.string().nullable(),
  songTitle: z.string().nullable(),
  /** The track's length before the edit (s); null for split-into-songs. */
  oldDurationSec: z.number().nullable(),
  durationSec: z.number(),
  /** 24-bit WAV the render makes (counts toward the quota with its variants). */
  estimatedBytes: z.number(),
  /** Estimated peak of the sum in dBFS (from the waveform peaks); null when unknown. */
  peakDb: z.number().nullable(),
});
export type EditReviewOutput = z.infer<typeof EditReviewOutputSchema>;

/** What the timeline follow-up will change (SPEC §24.4); null when nothing is remapped. */
export const EditRemapSummarySchema = z.object({
  markersMoved: z.number().int(),
  markersDeleted: z.number().int(),
  sectionsMoved: z.number().int(),
  sectionsDeleted: z.number().int(),
  commentsMoved: z.number().int(),
  commentsEditedOut: z.number().int(),
  /** Whether the tempo map changes, and its segment count before/after (null without a map). */
  tempoChanged: z.boolean(),
  tempoSegmentsBefore: z.number().int().nullable(),
  tempoSegmentsAfter: z.number().int().nullable(),
});
export type EditRemapSummary = z.infer<typeof EditRemapSummarySchema>;

export const EditReviewSchema = z.object({
  kind: EditOutcomeKindSchema,
  /** The session rev the review was made for (Apply/Bounce must name it). */
  rev: z.number().int(),
  outputs: z.array(EditReviewOutputSchema),
  totalBytes: z.number(),
  /** The applying user's remaining quota (bytes, after the 1.1 overhead); null = unlimited. */
  quotaRemainingBytes: z.number().nullable(),
  /** Free disk on the server (bytes); null when unknown. */
  diskFreeBytes: z.number().nullable(),
  /** Whether the outputs fit (quota with overhead; disk keeping its reserve). */
  fitsQuota: z.boolean(),
  fitsDisk: z.boolean(),
  /** ≈ 0.15 × edited duration × outputs (SPEC §24.8). */
  estimatedSec: z.number(),
  warnings: z.array(EditReviewWarningSchema),
  remap: EditRemapSummarySchema.nullable(),
  /**
   * Split into songs: the candidate ranges on the edited timeline (lane-0 sections; consecutive
   * markers incl. the `start` range from 0:00). Empty for the other kinds.
   */
  ranges: z.object({
    sections: z.array(EditSongRangeSchema),
    markers: z.array(EditSongRangeSchema),
  }),
});
export type EditReview = z.infer<typeof EditReviewSchema>;

const boolQuery = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")
  .optional();

export const EditReviewQuerySchema = z.object({
  kind: EditOutcomeKindSchema,
  /** Split into songs: which candidate list (default `sections`, else `markers`). */
  by: z.enum(["sections", "markers"]).optional(),
  /** Split into songs: comma-separated range ids to render (default: all of `by`). */
  ranges: z.string().max(20_000).optional(),
  title: EditSongNamingSchema.shape.title.unwrap().optional(),
  numbered: boolQuery,
  trackNames: EditSongNamingSchema.shape.trackNames.unwrap().optional(),
});
export type EditReviewQuery = z.input<typeof EditReviewQuerySchema>;

/** The review dialog's data (SPEC §24.8): outputs, sizes vs quota and disk, warnings, remap. */
export const reviewEditSession = defineContract({
  method: "GET",
  path: "/edit-sessions/:id/review",
  params: SessionParams,
  query: EditReviewQuerySchema,
  response: z.object({ review: EditReviewSchema }),
  errors: ["FORBIDDEN", "EDIT_SESSION_STATE", "NOT_SESSION_OWNER", "VALIDATION_FAILED"],
  auth: { capability: "audio.edit", scope: "editSession" },
});

export const ApplyEditSessionSchema = z.object({
  /** Idempotency key (`client_requests`): a replay answers the first response. */
  requestId: z.uuid(),
  /** The rev the review was made for. */
  rev: z.number().int().min(0),
});
export type ApplyEditSession = z.infer<typeof ApplyEditSessionSchema>;

/** A range to make a song from, with its final (possibly edited) title. */
export const EditBounceRangeSchema = EditSongRangeSchema.pick({
  id: true,
  name: true,
  startFrame: true,
  endFrame: true,
}).extend({ title: SongTitleSchema });
export type EditBounceRange = z.infer<typeof EditBounceRangeSchema>;

export const MAX_EDIT_BOUNCE_SONGS = 100;

export const BounceEditSessionSchema = ApplyEditSessionSchema.extend({
  kind: z.enum(["bounceVersions", "bounceTracks", "bounceSongs"]),
  /** Split into songs: the ranges (titles final), in timeline order. */
  ranges: z.array(EditBounceRangeSchema).min(1).max(MAX_EDIT_BOUNCE_SONGS).optional(),
  naming: EditSongNamingSchema.optional(),
  /** Split into songs: copy the tempo map into the new songs (default: no). */
  carryTempo: z.boolean().optional(),
  /** Split into songs: the session stays open (and the song locked) after the commit. */
  keepEditing: z.boolean().optional(),
})
  .refine((b) => b.kind !== "bounceSongs" || (b.ranges?.length ?? 0) > 0, {
    message: "Split into songs needs ranges",
    path: ["ranges"],
  })
  .refine((b) => (b.ranges ?? []).every((r) => r.endFrame > r.startFrame), {
    message: "A range ends after it starts",
    path: ["ranges"],
  });
export type BounceEditSession = z.infer<typeof BounceEditSessionSchema>;

const ApplyErrors = [
  "FORBIDDEN",
  "EDIT_SESSION_STATE",
  "EDIT_CONFLICT",
  "NOT_SESSION_OWNER",
  "QUOTA_EXCEEDED",
  "DISK_FULL",
  "VALIDATION_FAILED",
] as const;

/**
 * Apply (SPEC §24.8): the session goes `applying`, every edited track renders into a hidden
 * version, and once all are ingested they replace the old ones (which go to the Trash) in one
 * commit. `VALIDATION_FAILED` with reason `noChanges` when nothing was edited.
 */
export const applyEditSession = defineContract({
  method: "POST",
  path: "/edit-sessions/:id/apply",
  params: SessionParams,
  body: ApplyEditSessionSchema,
  response: SessionResponse,
  errors: ApplyErrors,
  auth: { capability: "audio.edit", scope: "editSession" },
});

/**
 * Bounce (SPEC §24.9): new versions, new tracks, or new songs (needs `song.create` on the
 * project, checked centrally) from the edit; renders first, commits atomically.
 */
export const bounceEditSession = defineContract({
  method: "POST",
  path: "/edit-sessions/:id/bounce",
  params: SessionParams,
  body: BounceEditSessionSchema,
  response: SessionResponse,
  errors: ApplyErrors,
  auth: {
    capability: "audio.edit",
    scope: "editSession",
    bodyProjectCapability: { field: "kind", value: "bounceSongs", capability: "song.create" },
  },
});

/** Re-queues the failed renders of the last Apply/Bounce (the session goes `applying` again). */
export const retryEditSession = defineContract({
  method: "POST",
  path: "/edit-sessions/:id/retry",
  params: SessionParams,
  response: SessionResponse,
  errors: ["FORBIDDEN", "EDIT_SESSION_STATE", "NOT_SESSION_OWNER", "QUOTA_EXCEEDED", "DISK_FULL"],
  auth: { capability: "audio.edit", scope: "editSession" },
});
