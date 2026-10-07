import { z } from "zod";
import { BatchResultSchema } from "./trash";

// Remove full quality (SPEC §26.4).

/** Variants that hold (or rebuild) the full-quality audio; Opus and peaks stay. */
export const LOSSLESS_VARIANTS = ["flac", "original", "wavmeta"] as const;
export type LosslessVariant = (typeof LOSSLESS_VARIANTS)[number];

/** Lists in a preview are capped; the counts are always complete. */
export const LOSSLESS_PREVIEW_LIST_MAX = 20;

/** A version named in a preview ("Bass v3 in Song"). */
export const LosslessVersionRefSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  trackName: z.string(),
  songTitle: z.string(),
});
export type LosslessVersionRef = z.infer<typeof LosslessVersionRefSchema>;

/** What `POST /batch/remove-lossless` would do (SPEC §26.4); nothing is changed. */
export const RemoveLosslessPreviewSchema = z.object({
  /** Versions whose full-quality files go. */
  versions: z.number().int(),
  /** Stored files removed, by kind (shared assets counted once). */
  files: z.object({
    flac: z.number().int(),
    original: z.number().int(),
    wavmeta: z.number().int(),
  }),
  /** Taken off the uploaders' storage usage at once. */
  usageBytes: z.number().int(),
  /**
   * Disk space freed by the daily blob GC: only files nothing else uses (identical uploads
   * share one stored file), so it can be less than `usageBytes`.
   */
  bytesFreed: z.number().int(),
  /** Lossy sources (e.g. MP3) whose original, the only full-quality copy, goes too. */
  lossySources: z.object({
    count: z.number().int(),
    items: z.array(LosslessVersionRefSchema).max(LOSSLESS_PREVIEW_LIST_MAX),
  }),
  /** Other versions (copies) that share these files and lose their full quality too. */
  sharedCopies: z.number().int(),
  /** Versions left out, by reason. */
  skipped: z.object({
    /** Still uploading or processing, or failed. */
    notReady: z.number().int(),
    /** No full-quality file left (removed before, or the automatic mix). */
    alreadyLossy: z.number().int(),
  }),
});
export type RemoveLosslessPreview = z.infer<typeof RemoveLosslessPreviewSchema>;

export const RemoveLosslessResultSchema = BatchResultSchema.extend({
  usageBytes: z.number().int(),
  bytesFreed: z.number().int(),
});
export type RemoveLosslessResult = z.infer<typeof RemoveLosslessResultSchema>;

/**
 * Why a version has no full-quality files: removed later, converted to lossy on upload, or
 * removed after a re-encode to another quality (SPEC §28.2, §28.3).
 */
export const ARCHIVED_REASONS = ["removed", "upload", "reencode"] as const;
export type ArchivedReason = (typeof ARCHIVED_REASONS)[number];
export const ArchivedReasonSchema = z.enum(ARCHIVED_REASONS);

/** When and by whom a version's full-quality files were removed. */
export const VersionArchivedSchema = z.object({
  at: z.number(),
  by: z.object({ id: z.string(), displayName: z.string() }).nullable(),
  reason: ArchivedReasonSchema,
});
export type VersionArchived = z.infer<typeof VersionArchivedSchema>;

/** How many of a song's current versions are lossy (SPEC §26.4 song list badge). */
export const SongLossySchema = z.enum(["none", "partial", "all"]);
export type SongLossy = z.infer<typeof SongLossySchema>;

/**
 * Whether a version has no full-quality audio: a lossy source, or its full-quality files were
 * removed. Versions still processing (no media facts yet) are not counted as lossy.
 */
export function isLossyVersion(v: {
  media: { lossless: boolean } | null;
  archived: VersionArchived | null;
}): boolean {
  return v.archived !== null || (v.media !== null && !v.media.lossless);
}

/** The song list badge from the lossy state of each counted current version. */
export function songLossyOf(flags: readonly boolean[]): SongLossy {
  const n = flags.filter(Boolean).length;
  if (n === 0) return "none";
  return n === flags.length ? "all" : "partial";
}
