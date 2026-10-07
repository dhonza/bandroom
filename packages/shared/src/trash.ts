import { z } from "zod";
import { TRASH_LIST_KINDS } from "./permissions/content";

/** At most this many ids in one batch call (SPEC §26.2). */
export const BATCH_MAX_ITEMS = 500;

const Ids = z.array(z.string().min(1).max(64)).max(BATCH_MAX_ITEMS);

/** Songs, tracks and versions selected for a batch action (SPEC §26.2). */
export const BatchItemsSchema = z
  .object({ songs: Ids.optional(), tracks: Ids.optional(), versions: Ids.optional() })
  .refine(
    (b) => {
      const n = (b.songs?.length ?? 0) + (b.tracks?.length ?? 0) + (b.versions?.length ?? 0);
      return n >= 1 && n <= BATCH_MAX_ITEMS;
    },
    { message: `between 1 and ${String(BATCH_MAX_ITEMS)} items` },
  );
export type BatchItems = z.infer<typeof BatchItemsSchema>;

/**
 * Trash items for restore and purge (SPEC §26.3): songs, tracks and versions, and also deleted
 * projects (admins) and documents.
 */
export const TrashBatchItemsSchema = z
  .object({
    songs: Ids.optional(),
    tracks: Ids.optional(),
    versions: Ids.optional(),
    projects: Ids.optional(),
    documents: Ids.optional(),
  })
  .refine(
    (b) => {
      const n =
        (b.songs?.length ?? 0) +
        (b.tracks?.length ?? 0) +
        (b.versions?.length ?? 0) +
        (b.projects?.length ?? 0) +
        (b.documents?.length ?? 0);
      return n >= 1 && n <= BATCH_MAX_ITEMS;
    },
    { message: `between 1 and ${String(BATCH_MAX_ITEMS)} items` },
  );
export type TrashBatchItems = z.infer<typeof TrashBatchItemsSchema>;

export const BatchResultSchema = z.object({
  ok: z.literal(true),
  batchId: z.string(),
  count: z.number().int(),
});
export type BatchResult = z.infer<typeof BatchResultSchema>;

export const BatchPurgeResultSchema = BatchResultSchema.extend({
  /** Bytes taken off the uploaders' usage; the files are deleted within minutes (`blob.gc`). */
  bytesFreed: z.number().int(),
});

/** One entry of a Trash list (SPEC §26.3). */
export const TrashItemSchema = z.object({
  kind: z.enum(TRASH_LIST_KINDS),
  id: z.string(),
  /** Project name, song title, track name, document title, or the version's label (may be empty). */
  name: z.string(),
  /** Version number (versions only). */
  number: z.number().int().nullable(),
  project: z.object({ id: z.string(), name: z.string() }),
  /** The item's song (null for projects and project-level documents). */
  song: z.object({ id: z.string(), title: z.string(), deleted: z.boolean() }).nullable(),
  /** The version's track (versions only). */
  track: z.object({ id: z.string(), name: z.string(), deleted: z.boolean() }).nullable(),
  deletedAt: z.number(),
  deletedBy: z.object({ id: z.string(), displayName: z.string() }).nullable(),
  /** When the daily maintenance will purge it. */
  purgeAt: z.number(),
  /** Storage it would free (usage of files no other item shares). */
  bytes: z.number().int(),
  /** Some of its files are shared with a copy (or another use) and stay when it is purged. */
  shared: z.boolean(),
  canRestore: z.boolean(),
  canPurge: z.boolean(),
});
export type TrashItem = z.infer<typeof TrashItemSchema>;

export const TrashListSchema = z.object({
  items: z.array(TrashItemSchema),
  retentionDays: z.number().int(),
});
export type TrashList = z.infer<typeof TrashListSchema>;
