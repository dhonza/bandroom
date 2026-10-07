import { z } from "zod";
import { OkSchema } from "./auth";
import { defineContract } from "./contract";

const IdParams = z.object({ id: z.string().min(1).max(64) });

/** Offline audio quality (SPEC §13): Opus, or Opus low ("small"). */
export const OfflineQualitySchema = z.enum(["normal", "small"]);
export type OfflineQuality = z.infer<typeof OfflineQualitySchema>;

const ManifestQuery = z.object({
  quality: OfflineQualitySchema.default("normal"),
  /**
   * Also FLAC ("offline lossless", desktop only by default). Versions whose full quality was
   * removed have none, so only their Opus is listed (SPEC §26.4).
   */
  lossless: z.enum(["true", "false"]).default("false"),
});

/** A content-addressed file to cache (`/blobs/:hash`) and its size. */
export const OfflineBlobSchema = z.object({
  hash: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type OfflineBlob = z.infer<typeof OfflineBlobSchema>;

/** A document version whose file the viewers read from `/document-versions/:id/content`. */
export const OfflineDocumentSchema = z.object({
  documentId: z.string(),
  versionId: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type OfflineDocument = z.infer<typeof OfflineDocumentSchema>;

/**
 * Everything one song needs offline (SPEC §13): current track versions in the chosen quality with
 * seek indexes and peaks, the Listen-mode mix, current document versions and the project image.
 */
export const OfflineSongManifestSchema = z.object({
  songId: z.string(),
  projectId: z.string(),
  title: z.string(),
  trackIds: z.array(z.string()),
  blobs: z.array(OfflineBlobSchema),
  documents: z.array(OfflineDocumentSchema),
});
export type OfflineSongManifest = z.infer<typeof OfflineSongManifestSchema>;

export const getSongOfflineManifest = defineContract({
  method: "GET",
  path: "/songs/:id/offline",
  params: IdParams,
  query: ManifestQuery,
  response: z.object({ song: OfflineSongManifestSchema }),
  auth: { capability: "stream", scope: "song" },
});

/** A project offline: all visible songs, the project's own documents and its image. */
export const OfflineProjectManifestSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  blobs: z.array(OfflineBlobSchema),
  documents: z.array(OfflineDocumentSchema),
  songs: z.array(OfflineSongManifestSchema),
});
export type OfflineProjectManifest = z.infer<typeof OfflineProjectManifestSchema>;

export const getProjectOfflineManifest = defineContract({
  method: "GET",
  path: "/projects/:id/offline",
  params: IdParams,
  query: ManifestQuery,
  response: z.object({ project: OfflineProjectManifestSchema }),
  auth: { capability: "view", scope: "project" },
});

/** `offline.added|removed` per device (SPEC §14.1); the session identifies the device. */
export const OfflineEventSchema = z.object({
  action: z.enum(["added", "removed"]),
  bytes: z.number().int().nonnegative().max(1e13),
  quality: OfflineQualitySchema,
  /** Client UUID (outbox replays, SPEC §18.3). */
  requestId: z.uuid().optional(),
});
export type OfflineEvent = z.infer<typeof OfflineEventSchema>;

export const recordSongOffline = defineContract({
  method: "POST",
  path: "/songs/:id/offline",
  params: IdParams,
  body: OfflineEventSchema,
  response: OkSchema,
  auth: { capability: "view", scope: "song" },
});

export const recordProjectOffline = defineContract({
  method: "POST",
  path: "/projects/:id/offline",
  params: IdParams,
  body: OfflineEventSchema,
  response: OkSchema,
  auth: { capability: "view", scope: "project" },
});
