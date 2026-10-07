import { z } from "zod";

/**
 * Samply import mapping (SPEC §17.1 steps 3–4): proposed by the scan, edited in the review UI,
 * executed by the import job. Node ids are Samply box ids.
 */
export const IMPORT_ACTIONS = [
  /** Stack or single audio file → song with one `mix` track (versions = stack children). */
  "songMix",
  /**
   * One song made of several tracks: a folder whose audio children point at it, or an audio
   * item the admin grouped with others of the same length (it becomes the first track).
   */
  "songMultitrack",
  /** Stack/file → a track of another song node (`targetId`). */
  "trackOf",
  /** Non-audio file → document on the song (inside a song folder) or the project. */
  "document",
  /** Folder that is not a song: its children are mapped on their own. */
  "container",
  "skip",
] as const;
export const ImportActionSchema = z.enum(IMPORT_ACTIONS);
export type ImportAction = z.infer<typeof ImportActionSchema>;

export const ImportVersionSchema = z.object({
  /** Samply file id. */
  id: z.string(),
  name: z.string(),
  durationSec: z.number().nullable(),
  sizeBytes: z.number().nullable(),
  timeCreated: z.number().nullable(),
  commentCount: z.number().int(),
  /** Already imported in an earlier run (import_map). */
  imported: z.boolean(),
});
export type ImportVersion = z.infer<typeof ImportVersionSchema>;

export interface ImportNode {
  id: string;
  kind: "folder" | "stack" | "file";
  name: string;
  action: ImportAction;
  /** `trackOf`: the song node this becomes a track of. `document`: optional song to attach to. */
  targetId: string | null;
  /** Track name when this node becomes a track (name minus the group's common prefix). */
  trackName: string;
  /** Song title for a `songMultitrack` node (defaults to `name`). */
  songTitle?: string;
  /**
   * The Samply project picture, which Samply also lists as a file. It becomes the project image;
   * as a document only if the admin chooses so.
   */
  isArtwork?: boolean;
  isAudio: boolean;
  /** Files of a stack (in version order), or the file itself. Empty for folders. */
  versions: ImportVersion[];
  children: ImportNode[];
}

export const ImportNodeSchema: z.ZodType<ImportNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    kind: z.enum(["folder", "stack", "file"]),
    name: z.string(),
    action: ImportActionSchema,
    targetId: z.string().nullable(),
    trackName: z.string(),
    songTitle: z.string().max(200).optional(),
    isArtwork: z.boolean().optional(),
    isAudio: z.boolean(),
    versions: z.array(ImportVersionSchema),
    children: z.array(ImportNodeSchema),
  }),
);

export const ImportProjectSchema = z.object({
  samplyId: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  artworkUrl: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  include: z.boolean(),
  /** Local project from an earlier run, if any (new items are added to it). */
  existingProjectId: z.string().nullable(),
  nodes: z.array(ImportNodeSchema),
});
export type ImportProject = z.infer<typeof ImportProjectSchema>;

export const ImportMappingSchema = z.object({
  projects: z.array(ImportProjectSchema),
  /** Import Samply insights as events (`details.imported`). Only the latest 100 per project. */
  includeInsights: z.boolean(),
  scannedAt: z.number(),
});
export type ImportMapping = z.infer<typeof ImportMappingSchema>;

export const ImportTotalsSchema = z.object({
  songs: z.number().int(),
  tracks: z.number().int(),
  versions: z.number().int(),
  documents: z.number().int(),
  comments: z.number().int(),
  /** New bytes to download (already imported versions excluded). */
  bytes: z.number(),
  alreadyImported: z.number().int(),
});
export type ImportTotals = z.infer<typeof ImportTotalsSchema>;

export const ImportRunStatusSchema = z.enum([
  "connected",
  "scanning",
  "review",
  "running",
  "done",
  "failed",
  "cancelled",
]);
export type ImportRunStatus = z.infer<typeof ImportRunStatusSchema>;

export const ImportReportItemSchema = z.object({
  kind: z.enum(["project", "song", "track", "version", "document", "comment", "insight"]),
  name: z.string(),
  outcome: z.enum(["imported", "existing", "skipped", "failed", "planned"]),
  reason: z.string().nullable(),
});
export type ImportReportItem = z.infer<typeof ImportReportItemSchema>;

export const ImportReportSchema = z.object({
  dryRun: z.boolean(),
  counts: z.record(z.string(), z.number()),
  items: z.array(ImportReportItemSchema),
  /** Comment authors without a matching local user (by email): candidates to invite. */
  unmatchedAuthors: z.array(z.object({ name: z.string(), email: z.string().nullable() })),
  log: z.array(z.string()),
});
export type ImportReport = z.infer<typeof ImportReportSchema>;

export const SamplyProjectSummarySchema = z.object({
  samplyId: z.string(),
  name: z.string(),
  sizeBytes: z.number().nullable(),
  timeModified: z.number().nullable(),
  /** Imported before (import_map): a re-run adds new items only. */
  existingProjectId: z.string().nullable(),
});
export type SamplyProjectSummary = z.infer<typeof SamplyProjectSummarySchema>;

export const ImportRunSchema = z.object({
  id: z.string(),
  source: z.literal("samply"),
  status: ImportRunStatusSchema,
  dryRun: z.boolean(),
  progress: z.number(),
  error: z.string().nullable(),
  selection: z.array(z.string()),
  mapping: ImportMappingSchema.nullable(),
  totals: ImportTotalsSchema.nullable(),
  report: ImportReportSchema.nullable(),
  /** Whether the API key is still held (cleared when the run finishes or is cancelled). */
  hasKey: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type ImportRun = z.infer<typeof ImportRunSchema>;
