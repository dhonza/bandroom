import { z } from "zod";
import {
  DescriptionSchema,
  GrantRowSchema,
  PaletteColorSchema,
  ProjectNameSchema,
  ProjectSchema,
  ProjectSummarySchema,
  SongSummarySchema,
  SongTitleSchema,
} from "../content";
import { ContentRoleSchema, DownloadPolicySchema } from "../permissions/content";
import { DownloadFormatSchema } from "../tracks";
import { OkSchema } from "./auth";
import { defineContract } from "./contract";

const IdParams = z.object({ id: z.string().min(1).max(64) });
const GrantParams = z.object({ id: z.string().min(1).max(64), userId: z.string().min(1).max(64) });

export const listProjects = defineContract({
  method: "GET",
  path: "/projects",
  query: z.object({ archived: z.enum(["true", "false"]).optional() }),
  response: z.object({ projects: z.array(ProjectSummarySchema) }),
  auth: { user: true },
});

export const createProject = defineContract({
  method: "POST",
  path: "/projects",
  body: z.object({
    name: ProjectNameSchema,
    description: DescriptionSchema.optional(),
    color: PaletteColorSchema.optional(),
  }),
  response: z.object({ project: ProjectSchema }),
  auth: { global: "project.create" },
});

export const getProject = defineContract({
  method: "GET",
  path: "/projects/:id",
  params: IdParams,
  response: z.object({ project: ProjectSchema }),
  errors: ["NOT_FOUND"],
  auth: { capability: "view", scope: "project" },
});

export const updateProject = defineContract({
  method: "PATCH",
  path: "/projects/:id",
  params: IdParams,
  body: z
    .object({
      name: ProjectNameSchema,
      description: DescriptionSchema,
      color: PaletteColorSchema,
      downloadPolicy: DownloadPolicySchema,
      archived: z.boolean(),
    })
    .partial(),
  response: z.object({ project: ProjectSchema }),
  auth: { capability: "settings.manage", scope: "project" },
});

/** Soft delete (trash, purged later). The client asks the user to type the name first. */
export const deleteProject = defineContract({
  method: "DELETE",
  path: "/projects/:id",
  params: IdParams,
  response: OkSchema,
  auth: { capability: "project.delete", scope: "project" },
});

export const transferProjectOwnership = defineContract({
  method: "POST",
  path: "/projects/:id/transfer-ownership",
  params: IdParams,
  body: z.object({ userId: z.string().min(1).max(64) }),
  response: z.object({ project: ProjectSchema }),
  errors: ["NOT_FOUND"],
  auth: { capability: "settings.manage", scope: "project" },
});

export const listProjectSongs = defineContract({
  method: "GET",
  path: "/projects/:id/songs",
  params: IdParams,
  response: z.object({ songs: z.array(SongSummarySchema) }),
  auth: { capability: "view", scope: "project" },
});

export const createSong = defineContract({
  method: "POST",
  path: "/projects/:id/songs",
  params: IdParams,
  body: z.object({
    title: SongTitleSchema,
    subtitle: z.string().trim().max(200).optional(),
    key: z.string().trim().max(40).optional(),
  }),
  response: z.object({ song: SongSummarySchema }),
  auth: { capability: "song.create", scope: "project" },
});

/** Full new order of the project's songs (ids not listed keep their relative order at the end). */
export const reorderSongs = defineContract({
  method: "PUT",
  path: "/projects/:id/songs/order",
  params: IdParams,
  body: z.object({ songIds: z.array(z.string().min(1).max(64)).max(2000) }),
  response: OkSchema,
  auth: { capability: "edit.any", scope: "project" },
});

export const listProjectGrants = defineContract({
  method: "GET",
  path: "/projects/:id/grants",
  params: IdParams,
  response: z.object({ grants: z.array(GrantRowSchema) }),
  auth: { capability: "grants.manage", scope: "project" },
});

export const setProjectGrant = defineContract({
  method: "PUT",
  path: "/projects/:id/grants/:userId",
  params: GrantParams,
  body: z.object({ role: ContentRoleSchema }),
  response: OkSchema,
  errors: ["NOT_FOUND"],
  auth: { capability: "grants.manage", scope: "project" },
});

/** Removes the explicit grant; the user falls back to the instance default. */
export const removeProjectGrant = defineContract({
  method: "DELETE",
  path: "/projects/:id/grants/:userId",
  params: GrantParams,
  response: OkSchema,
  auth: { capability: "grants.manage", scope: "project" },
});

/**
 * The server fetches an image URL for the crop dialog (SPEC §25.4) and answers with the image
 * bytes, not JSON, so this is a binary route (same capability as uploading a project image).
 */
export const PROJECT_IMAGE_FETCH_PATH = "/projects/:id/image/fetch";
export const ImageUrlFetchSchema = z.object({ url: z.string().trim().min(1).max(2048) });
/** Largest image fetched from a URL. */
export const IMAGE_URL_MAX_BYTES = 20 * 1024 * 1024;

/** Query of the project export (SPEC §28.7); FLAC by default. */
export const ProjectExportQuerySchema = z.object({
  format: DownloadFormatSchema.default("flac"),
});

export const ProjectExportPreviewSchema = z.object({
  /** Audio files and documents in the archive. */
  files: z.number().int(),
  /** Songs with at least one file. */
  songs: z.number().int(),
  /** Songs left out because their download policy forbids the user. */
  skippedSongs: z.number().int(),
  documents: z.number().int(),
  /** Versions exported as Opus (full quality removed). */
  opusFallbacks: z.number().int(),
  /** Versions exported as the uploaded file (lossy source: no FLAC or WAV). */
  originalFallbacks: z.number().int(),
  /** Exact size of the ZIP. */
  bytes: z.number(),
});
export type ProjectExportPreview = z.infer<typeof ProjectExportPreviewSchema>;

/**
 * What a project export would hold (SPEC §28.7). The archive itself is
 * `GET /projects/:id/export/download?format=` (same auth, streamed, not a contract).
 */
export const getProjectExportPreview = defineContract({
  method: "GET",
  path: "/projects/:id/export/preview",
  params: IdParams,
  query: ProjectExportQuerySchema,
  response: ProjectExportPreviewSchema,
  auth: { capability: "download", scope: "project" },
});
