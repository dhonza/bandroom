import type { Db } from "../db/connection";
import { enqueueJob } from "../jobs/queue";

/** Queues `audio.ingest` (SPEC §5.3) for one track version's file. */
export function enqueueAudioIngest(
  db: Db,
  input: {
    assetId: string;
    projectId: string;
    songId: string;
    trackVersionId: string;
    createdBy: string | null;
    priority?: number;
  },
): void {
  enqueueJob(db, {
    type: "audio.ingest",
    capability: "audio.ingest",
    payload: {
      assetId: input.assetId,
      projectId: input.projectId,
      songId: input.songId,
      trackVersionId: input.trackVersionId,
    },
    dedupeKey: `ingest:${input.assetId}`,
    priority: input.priority ?? 0,
    createdBy: input.createdBy,
  });
}

/** Queues `image.ingest` in logo mode for the branding logo (SPEC §25.1). */
export function enqueueLogoIngest(
  db: Db,
  input: { assetId: string; createdBy: string | null },
): void {
  enqueueJob(db, {
    type: "image.ingest",
    capability: "image.ingest",
    payload: { assetId: input.assetId, crop: false, logo: true, projectId: null },
    priority: 0,
    createdBy: input.createdBy,
  });
}

/** Queues `image.ingest` (SPEC §5.7) for a project image (cover-cropped to a square). */
export function enqueueProjectImageIngest(
  db: Db,
  input: { assetId: string; projectId: string; createdBy: string | null; priority?: number },
): void {
  enqueueJob(db, {
    type: "image.ingest",
    capability: "image.ingest",
    payload: { assetId: input.assetId, crop: true, projectId: input.projectId },
    priority: input.priority ?? 0,
    createdBy: input.createdBy,
  });
}
