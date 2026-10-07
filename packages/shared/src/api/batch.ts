import { z } from "zod";
import {
  BatchItemsSchema,
  BatchPurgeResultSchema,
  BatchResultSchema,
  TrashBatchItemsSchema,
  TrashListSchema,
} from "../trash";
import {
  RemoveLosslessPreviewSchema,
  RemoveLosslessRequestSchema,
  RemoveLosslessResultSchema,
} from "../lossless";
import {
  BatchTransferResultSchema,
  MakeMultitrackSchema,
  MultitrackItemsSchema,
  MultitrackPreviewSchema,
  SongsToProjectSchema,
} from "../multitrack";
import { defineContract } from "./contract";

const IdParams = z.object({ id: z.string().min(1).max(64) });

/**
 * Moves songs, tracks and versions to the Trash (SPEC §26.2, §26.3): one transaction, all or
 * nothing; every item is checked centrally first.
 */
export const batchDelete = defineContract({
  method: "POST",
  path: "/batch/delete",
  body: BatchItemsSchema,
  response: BatchResultSchema,
  errors: ["NOT_FOUND", "FORBIDDEN_ITEMS"],
  auth: { batch: "delete" },
});

/** Restores items from the Trash; tracks/versions of a deleted song need the song too. */
export const batchRestore = defineContract({
  method: "POST",
  path: "/batch/restore",
  body: TrashBatchItemsSchema,
  response: BatchResultSchema,
  errors: ["NOT_FOUND", "FORBIDDEN_ITEMS", "TRASH_PARENT_DELETED"],
  auth: { batch: "restore" },
});

/** Deletes Trash items permanently (also "Empty Trash", in chunks). Irreversible. */
export const batchPurge = defineContract({
  method: "POST",
  path: "/batch/purge",
  body: TrashBatchItemsSchema,
  response: BatchPurgeResultSchema,
  errors: ["NOT_FOUND", "FORBIDDEN_ITEMS"],
  auth: { batch: "purge" },
});

/**
 * What removing the full-quality files of the items would do (SPEC §26.4): songs stand for all
 * versions of their tracks, tracks for all their versions. Same checks as the action itself.
 */
export const batchRemoveLosslessPreview = defineContract({
  method: "POST",
  path: "/batch/remove-lossless/preview",
  body: RemoveLosslessRequestSchema,
  response: RemoveLosslessPreviewSchema,
  errors: ["NOT_FOUND", "FORBIDDEN_ITEMS"],
  auth: { batch: "removeLossless" },
});

/**
 * Removes the FLAC, kept original and WAV metadata of the items' versions (SPEC §26.4); Opus and
 * peaks stay. Irreversible; versions not ready or already lossy are skipped.
 */
export const batchRemoveLossless = defineContract({
  method: "POST",
  path: "/batch/remove-lossless",
  body: RemoveLosslessRequestSchema,
  response: RemoveLosslessResultSchema,
  errors: ["NOT_FOUND", "FORBIDDEN_ITEMS"],
  auth: { batch: "removeLossless" },
});

/**
 * What making a multitrack song from the items would do (SPEC §26.5): the tracks in order, their
 * lengths, the suggested name and which source songs would be emptied. Nothing is changed.
 */
export const batchMultitrackPreview = defineContract({
  method: "POST",
  path: "/batch/make-multitrack/preview",
  body: MultitrackItemsSchema,
  response: MultitrackPreviewSchema,
  errors: ["NOT_FOUND", "FORBIDDEN_ITEMS", "BAD_REQUEST"],
  auth: { batch: "inspect" },
});

/**
 * Moves the tracks (songs stand for all their tracks) with all their versions into one new song
 * in the target project (SPEC §26.5, §26.6). Source songs left without tracks go to the Trash.
 */
export const batchMakeMultitrack = defineContract({
  method: "POST",
  path: "/batch/make-multitrack",
  body: MakeMultitrackSchema,
  response: BatchTransferResultSchema,
  errors: ["NOT_FOUND", "FORBIDDEN_ITEMS", "FORBIDDEN", "BAD_REQUEST"],
  auth: { batch: "move" },
});

/** Copies the tracks into one new song in the target project; the sources stay (SPEC §26.6). */
export const batchCopyTracks = defineContract({
  method: "POST",
  path: "/batch/copy-tracks",
  body: MakeMultitrackSchema,
  response: BatchTransferResultSchema,
  errors: ["NOT_FOUND", "FORBIDDEN_ITEMS", "FORBIDDEN", "BAD_REQUEST"],
  auth: { batch: "copy" },
});

/** Copies songs to a project, sharing the stored files (SPEC §26.6). */
export const batchCopySongs = defineContract({
  method: "POST",
  path: "/batch/copy-songs",
  body: SongsToProjectSchema,
  response: BatchTransferResultSchema,
  errors: ["NOT_FOUND", "FORBIDDEN_ITEMS", "FORBIDDEN"],
  auth: { batch: "copy" },
});

/** Moves songs to another project (SPEC §26.6); song grants are dropped. */
export const batchMoveSongs = defineContract({
  method: "POST",
  path: "/batch/move-songs",
  body: SongsToProjectSchema,
  response: BatchTransferResultSchema,
  errors: ["NOT_FOUND", "FORBIDDEN_ITEMS", "FORBIDDEN", "BAD_REQUEST"],
  auth: { batch: "move" },
});

/** The project's Trash: deleted songs, tracks and versions the user can see (SPEC §26.3). */
export const listProjectTrash = defineContract({
  method: "GET",
  path: "/projects/:id/trash",
  params: IdParams,
  response: TrashListSchema,
  auth: { capability: "delete.own", scope: "project" },
});

/** Every project's Trash (Admin → Trash). */
export const listAdminTrash = defineContract({
  method: "GET",
  path: "/admin/trash",
  response: TrashListSchema,
  auth: { global: "admin.access" },
});
