import { z } from "zod";
import {
  CapabilitySchema,
  ContentRoleSchema,
  DownloadPolicySchema,
  SongDownloadPolicySchema,
} from "./permissions/content";
import { GlobalRoleSchema } from "./permissions/global";
import { SongLossySchema } from "./lossless";

/**
 * Colors of the shared 16-color palette (SPEC §11.5): tracks, projects, sections and comment
 * authors. Ordered around the hue wheel (four rows of four in the pickers), with the two muted
 * colors last. `brown`, `gold`, `mint` and `slate` are custom theme colors; the others are
 * Mantine's. Stored as text, so adding colors needs no migration.
 */
export const PALETTE_COLORS = [
  "red",
  "orange",
  "gold",
  "yellow",
  "lime",
  "green",
  "mint",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "violet",
  "grape",
  "pink",
  "brown",
  "slate",
] as const;
export const PaletteColorSchema = z.enum(PALETTE_COLORS);
export type PaletteColor = z.infer<typeof PaletteColorSchema>;

export const EffectiveRoleSchema = z.union([ContentRoleSchema, z.literal("admin")]);

/** What the current user may do in a scope, computed by the server's permission module. */
export const AccessSchema = z.object({
  role: EffectiveRoleSchema,
  capabilities: z.array(CapabilitySchema),
});
export type Access = z.infer<typeof AccessSchema>;

export const ProjectNameSchema = z.string().trim().min(1).max(120);
export const DescriptionSchema = z.string().max(10_000);

export const ProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  color: PaletteColorSchema,
  songCount: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable(),
  /** Blob hash of the 512 px WebP project image (null: none or still processing). */
  imageHash: z.string().nullable(),
  /** "reduced": the user only sees songs granted to them individually (SPEC §3.3). */
  visibility: z.enum(["full", "reduced"]),
  access: AccessSchema,
  /**
   * Bytes of the stored files of its songs, documents and image (SPEC §28.6); null when the user
   * sees the project only partly, absent on public links.
   */
  bytes: z.number().nullable().optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const ProjectSchema = ProjectSummarySchema.extend({
  description: z.string(),
  downloadPolicy: DownloadPolicySchema,
  ownerId: z.string(),
  ownerDisplayName: z.string().nullable(),
  createdAt: z.number(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const SongTitleSchema = z.string().trim().min(1).max(200);

/**
 * Media work on a song (SPEC §25.3): its current track versions whose files are waiting, being
 * processed or failed, and the mean progress of those being processed.
 */
export const ProcessingSchema = z.object({
  queued: z.number().int(),
  processing: z.number().int(),
  failed: z.number().int(),
  progress: z.number().nullable(),
});
export type Processing = z.infer<typeof ProcessingSchema>;

export const SongSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  subtitle: z.string(),
  key: z.string(),
  sortOrder: z.number(),
  updatedAt: z.number(),
  access: AccessSchema,
  /** Only in project song lists (SPEC §25.3). */
  processing: ProcessingSchema.optional(),
  /**
   * Only in project song lists (SPEC §26.4): whether the current versions of the song's tracks
   * (ready ones only) are lossy — none, some or all.
   */
  lossy: SongLossySchema.optional(),
  /** Bytes of the stored files of its tracks and tempo MIDI (SPEC §28.6); not on public links. */
  bytes: z.number().optional(),
});
export type SongSummary = z.infer<typeof SongSummarySchema>;

/** A locked song (SPEC §25.12): when and by whom. */
export const SongLockSchema = z.object({
  at: z.number(),
  by: z.object({ id: z.string().nullable(), displayName: z.string().nullable() }),
});
export type SongLock = z.infer<typeof SongLockSchema>;

export const SongSchema = SongSummarySchema.extend({
  notes: z.string(),
  /** Null when the song is not locked. */
  locked: SongLockSchema.nullable(),
  downloadPolicy: SongDownloadPolicySchema,
  createdAt: z.number(),
  /**
   * Whether the user may bounce this song's mix into a new song (SPEC §5.5: `stream` here and
   * `song.create` on the project, {@link canBounce}). Absent for link visitors.
   */
  canBounce: z.boolean().optional(),
  project: z.object({
    id: z.string(),
    name: z.string(),
    color: PaletteColorSchema,
    imageHash: z.string().nullable(),
  }),
});
export type Song = z.infer<typeof SongSchema>;

/** One row of the grants editor: every active user and how their role comes about. */
export const GrantRowSchema = z.object({
  userId: z.string(),
  username: z.string(),
  displayName: z.string(),
  globalRole: GlobalRoleSchema,
  /** Explicit grant at this scope, or null when inherited. */
  grant: ContentRoleSchema.nullable(),
  /** Role the user would have without the explicit grant (default or project role). */
  inherited: EffectiveRoleSchema,
  effective: EffectiveRoleSchema,
});
export type GrantRow = z.infer<typeof GrantRowSchema>;

export const DirectoryUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  globalRole: GlobalRoleSchema,
});
export type DirectoryUser = z.infer<typeof DirectoryUserSchema>;
