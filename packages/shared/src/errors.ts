import { z } from "zod";

/**
 * Stable error codes returned by the API. The client translates them (i18n key `errors.<CODE>`);
 * server-side messages are for logs only.
 */
export const ERROR_CODES = [
  "BAD_REQUEST",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "CSRF_HEADER_MISSING",
  "RATE_LIMITED",
  "INTERNAL",
  "INVALID_CREDENTIALS",
  "TOKEN_INVALID",
  "USERNAME_TAKEN",
  "EMAIL_TAKEN",
  "WRONG_PASSWORD",
  "LAST_ADMIN",
  "QUOTA_EXCEEDED",
  "FILE_TOO_LARGE",
  "DISK_FULL",
  "UNSUPPORTED_FILE",
  "SAMPLY_AUTH_FAILED",
  "SAMPLY_UNAVAILABLE",
  "IMPORT_STATE",
  "IMPORT_KEY_GONE",
  "MIDI_INVALID",
  "MIDI_SMPTE",
  "MIDI_FORMAT",
  "NO_TEMPO",
  "EDIT_CONFLICT",
  "LINK_NAME_REQUIRED",
  "LOGO_TOO_WIDE",
  "SAMPLY_KEY_NOT_SAVED",
  "IMAGE_URL_INVALID",
  "IMAGE_URL_BLOCKED",
  "IMAGE_URL_TOO_LARGE",
  "IMAGE_URL_NOT_IMAGE",
  "IMAGE_URL_FAILED",
  "SONG_LOCKED",
  "FORBIDDEN_ITEMS",
  "TRASH_PARENT_DELETED",
  "LOSSLESS_REMOVED",
  "BOUNCE_INVALID",
  "BOUNCE_SILENT",
  "API_KEY_INVALID",
  "API_KEY_SCOPE",
  "API_KEY_LIMIT",
  "DUPLICATE_VERSION",
  "UPDATE_PENDING",
  "UPDATE_CHECK_FAILED",
  "UPDATE_TAG_UNKNOWN",
  "UPDATE_CONFIRM_MISMATCH",
  "JOB_STATE",
  "EDIT_SESSION_OPEN",
  "EDIT_SESSION_STATE",
  "NOT_SESSION_OWNER",
  "SONG_EDITING",
  "PROJECT_EDITING",
  "PROCESSING_SOURCE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ERROR_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_HEADER_MISSING: 403,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  INVALID_CREDENTIALS: 401,
  TOKEN_INVALID: 410,
  USERNAME_TAKEN: 409,
  EMAIL_TAKEN: 409,
  WRONG_PASSWORD: 403,
  LAST_ADMIN: 409,
  QUOTA_EXCEEDED: 413,
  FILE_TOO_LARGE: 413,
  DISK_FULL: 507,
  UNSUPPORTED_FILE: 415,
  /** The Samply API rejected the key. */
  SAMPLY_AUTH_FAILED: 400,
  SAMPLY_UNAVAILABLE: 502,
  /** The import run is not in a state that allows this step. */
  IMPORT_STATE: 409,
  /** The run's API key was cleared (finished or cancelled): connect again. */
  IMPORT_KEY_GONE: 409,
  /** Not a readable Standard MIDI File (SPEC §7.2). */
  MIDI_INVALID: 400,
  /** SMPTE timebase: only PPQ files carry a tempo map. */
  MIDI_SMPTE: 400,
  /** MIDI type 2 (only types 0 and 1 are supported). */
  MIDI_FORMAT: 400,
  /** The action needs a tempo map. */
  NO_TEMPO: 409,
  /** Someone saved a newer version of the document while it was being edited. */
  EDIT_CONFLICT: 409,
  /** Anonymous link visitors enter a display name before commenting (SPEC §3.5). */
  LINK_NAME_REQUIRED: 400,
  /** The branding logo is wider than 4:1 (SPEC §25.1). */
  LOGO_TOO_WIDE: 400,
  /** "Use saved key" without a saved Samply key (SPEC §25.11). */
  SAMPLY_KEY_NOT_SAVED: 409,
  /** Image from a URL (SPEC §25.4): not an http(s) URL, or credentials in it. */
  IMAGE_URL_INVALID: 400,
  /** The URL points to a private, loopback or otherwise non-public address, or a closed port. */
  IMAGE_URL_BLOCKED: 400,
  IMAGE_URL_TOO_LARGE: 413,
  /** The URL does not answer with a PNG, JPEG, GIF, WebP or AVIF image. */
  IMAGE_URL_NOT_IMAGE: 415,
  /** The remote server failed, timed out or redirected too often. */
  IMAGE_URL_FAILED: 502,
  /** The song is locked: markers, comments, the default mix, version gain and tempo are frozen. */
  SONG_LOCKED: 409,
  /**
   * A batch action includes items the user may not change (SPEC §26.2); `params.ids` lists them
   * (comma-separated) and `params.count` counts them. Nothing was changed.
   */
  FORBIDDEN_ITEMS: 403,
  /** Restoring a track or version whose song (or track) is still in the Trash (SPEC §26.3). */
  TRASH_PARENT_DELETED: 409,
  /** The version's full-quality files were removed (SPEC §26.4): no FLAC, WAV or original. */
  LOSSLESS_REMOVED: 410,
  /**
   * A bounce names a track or version that is not in the song, or a version that is not ready
   * (SPEC §5.5).
   */
  BOUNCE_INVALID: 400,
  /** Every track of the bounce is muted, silenced by a solo or at the fader bottom (SPEC §5.5). */
  BOUNCE_SILENT: 400,
  /** The bearer API key is unknown, revoked or expired, or its user is disabled (SPEC §29.3). */
  API_KEY_INVALID: 401,
  /** The API key's scopes do not cover this route, or keys may not use it (SPEC §29.2). */
  API_KEY_SCOPE: 403,
  /** The user already has the maximum number of active API keys. */
  API_KEY_LIMIT: 409,
  /** The upload equals the track's current version (`sha256` in the target, SPEC §29.5). */
  DUPLICATE_VERSION: 409,
  /** An update request is already pending or running (SPEC §29.8). */
  UPDATE_PENDING: 409,
  /** The image registry could not be reached or answered unexpectedly. */
  UPDATE_CHECK_FAILED: 502,
  /** The requested tag is not among the available release tags. */
  UPDATE_TAG_UNKNOWN: 400,
  /** A rollback named another version than the running one. */
  UPDATE_CONFIRM_MISMATCH: 409,
  /** The job is not in a state that allows this action (retry/cancel). */
  JOB_STATE: 409,
  /** Another edit session is open on the song (SPEC §24.7); the client offers a takeover. */
  EDIT_SESSION_OPEN: 409,
  /** The edit session is not in a state that allows this action (e.g. already cancelled). */
  EDIT_SESSION_STATE: 409,
  /** Only the session's owner saves it (SPEC §24.12); the client offers a takeover. */
  NOT_SESSION_OWNER: 409,
  /** Someone is editing the song: its tracks, timeline and comments are frozen (SPEC §24.7). */
  SONG_EDITING: 409,
  /** A song of the project is being edited: the project cannot be deleted or purged (SPEC §24.7). */
  PROJECT_EDITING: 409,
  /** A current version of the song is still being processed (SPEC §24.7). */
  PROCESSING_SOURCE: 409,
};

export const FieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

/**
 * Wire format of every error response. `code` is a plain string on the wire so that an older
 * client keeps working when a newer server introduces a code; use {@link isErrorCode} to narrow.
 */
export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  fieldErrors: z.array(FieldErrorSchema).optional(),
});

export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}
