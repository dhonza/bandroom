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
