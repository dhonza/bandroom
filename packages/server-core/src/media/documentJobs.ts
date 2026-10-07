import { documentVersionsWithoutProbe } from "../content/documents";
import type { Db } from "../db/connection";
import { enqueueJob } from "../jobs/queue";

/** Queues `document.ingest` (SPEC §5.7) for one document version's file. */
export function enqueueDocumentIngest(
  db: Db,
  input: {
    assetId: string;
    documentId: string;
    documentVersionId: string;
    projectId: string;
    createdBy: string | null;
    priority?: number;
  },
): void {
  enqueueJob(db, {
    type: "document.ingest",
    capability: "document.ingest",
    payload: {
      assetId: input.assetId,
      documentId: input.documentId,
      documentVersionId: input.documentVersionId,
      projectId: input.projectId,
    },
    priority: input.priority ?? 0,
    dedupeKey: `docingest:${input.assetId}`,
    createdBy: input.createdBy,
  });
}

/**
 * One-time backfill: document versions stored without `document.ingest` (Samply imports before
 * M9) get their kind detected and previews built. Runs at server start; idempotent (dedupe key,
 * and the job writes the probe). Low priority, below interactive uploads.
 */
export function enqueueDocumentBackfill(db: Db): number {
  const todo = documentVersionsWithoutProbe(db);
  for (const v of todo) {
    enqueueDocumentIngest(db, {
      assetId: v.assetId,
      documentId: v.documentId,
      documentVersionId: v.versionId,
      projectId: v.projectId,
      createdBy: null,
      priority: -5,
    });
  }
  return todo.length;
}
