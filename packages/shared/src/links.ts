import { z } from "zod";
import { PaletteColorSchema } from "./content";
import { LINK_STATUSES, LinkScopeSchema, LinkVersionModeSchema } from "./permissions/links";

/** Public links (SPEC §3.5). Tokens are 128-bit random, base64url (22 characters). */
export const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

/** API routes for link visitors live under `/l/:token` (below the API prefix). */
export function linkApiRoot(token: string): string {
  return `/l/${encodeURIComponent(token)}`;
}

export const LinkLabelSchema = z.string().trim().max(120);
export const LinkPasswordSchema = z.string().min(4).max(200);
export const VisitorNameSchema = z.string().trim().min(1).max(60);

export const LinkStatsSchema = z.object({
  /** New link sessions (first opens). */
  opens: z.number(),
  /** Distinct visitors (link sessions) that did anything. */
  visitors: z.number(),
  plays: z.number(),
  downloads: z.number(),
  comments: z.number(),
  passwordFailures: z.number(),
  lastAccessAt: z.number().nullable(),
});
export type LinkStats = z.infer<typeof LinkStatsSchema>;

/** A link as its managers see it. */
export const PublicLinkSchema = z.object({
  id: z.string(),
  /** Absolute URL (APP_URL incl. base path + `/l/<token>`). */
  url: z.string(),
  label: z.string(),
  scopeType: LinkScopeSchema,
  projectId: z.string(),
  projectName: z.string(),
  songId: z.string().nullable(),
  songTitle: z.string().nullable(),
  versionIds: z.array(z.string()),
  versions: LinkVersionModeSchema,
  hasPassword: z.boolean(),
  expiresAt: z.number().nullable(),
  active: z.boolean(),
  revokedAt: z.number().nullable(),
  status: z.enum(LINK_STATUSES),
  allowDownload: z.boolean(),
  /** False when the download policy keeps viewers from downloading despite `allowDownload`. */
  downloadPolicyAllows: z.boolean(),
  allowComments: z.boolean(),
  showComments: z.boolean(),
  createdBy: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  stats: LinkStatsSchema,
});
export type PublicLink = z.infer<typeof PublicLinkSchema>;

const LinkSettingsShape = {
  label: LinkLabelSchema,
  versions: LinkVersionModeSchema,
  /** Null = never expires. Must lie in the future. */
  expiresAt: z.number().int().positive().nullable(),
  allowDownload: z.boolean(),
  allowComments: z.boolean(),
  showComments: z.boolean(),
};

export const CreateLinkSchema = z.object({
  ...LinkSettingsShape,
  scopeType: LinkScopeSchema,
  /** `versions` links: 1–200 track versions of the song. */
  versionIds: z.array(z.string().min(1).max(64)).max(200).optional(),
  password: LinkPasswordSchema.optional(),
});
export type CreateLink = z.input<typeof CreateLinkSchema>;

export const UpdateLinkSchema = z
  .object({
    ...LinkSettingsShape,
    active: z.boolean(),
    /** A new password, or null to remove it. Changing it ends all visitor sessions. */
    password: LinkPasswordSchema.nullable(),
  })
  .partial();
export type UpdateLink = z.input<typeof UpdateLinkSchema>;

export const LinkActivitySchema = z.object({
  id: z.string(),
  ts: z.number(),
  action: z.string(),
  /** Short anonymous visitor id (first 8 characters of the link session id). */
  visitor: z.string().nullable(),
  visitorName: z.string().nullable(),
  songId: z.string().nullable(),
  songTitle: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export type LinkActivity = z.infer<typeof LinkActivitySchema>;

export const LinkAnalyticsSchema = z.object({
  stats: LinkStatsSchema,
  /** Per song: plays and downloads. */
  songs: z.array(
    z.object({
      songId: z.string(),
      title: z.string(),
      plays: z.number(),
      downloads: z.number(),
      comments: z.number(),
    }),
  ),
  recent: z.array(LinkActivitySchema),
});
export type LinkAnalytics = z.infer<typeof LinkAnalyticsSchema>;

// ——— the visitor's side ————————————————————————————————————————————————————————————————

/** What the link view needs after opening (no internal label, no ids of other content). */
export const LinkViewSchema = z.object({
  scopeType: LinkScopeSchema,
  versions: LinkVersionModeSchema,
  allowComments: z.boolean(),
  showComments: z.boolean(),
  /** Effective: the link allows downloads and the download policy lets viewers download. */
  allowDownload: z.boolean(),
  expiresAt: z.number().nullable(),
  project: z.object({
    id: z.string(),
    name: z.string(),
    color: PaletteColorSchema,
    imageHash: z.string().nullable(),
  }),
  /** The song of a song/versions link. */
  songId: z.string().nullable(),
  visitor: z.object({ name: z.string().nullable() }),
});
export type LinkView = z.infer<typeof LinkViewSchema>;

export const LinkOpenResultSchema = z.discriminatedUnion("state", [
  /** Before the password: nothing about the content. */
  z.object({ state: z.literal("password") }),
  z.object({ state: z.literal("open"), view: LinkViewSchema }),
]);
export type LinkOpenResult = z.infer<typeof LinkOpenResultSchema>;
