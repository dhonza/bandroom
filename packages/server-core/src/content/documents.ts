import { uuidv7, type DocumentKind as SharedDocumentKind } from "@bandroom/shared";
import { and, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import { assets, documents, documentVersions } from "../db/schema";
import { touchProject } from "./projects";

export type DocumentRow = typeof documents.$inferSelect;
export type DocumentVersionRow = typeof documentVersions.$inferSelect;
export type DocumentKind = DocumentRow["kind"];

/** Compile-time check: the DB enum and the shared enum stay the same. */
export const DOCUMENT_KIND_ENUMS_MATCH: SharedDocumentKind extends DocumentKind ? true : never =
  true;

/** Creates a document with its first version (SPEC §4.2, §10). */
export function createDocumentWithVersion(
  db: Db,
  input: {
    projectId: string;
    title: string;
    kind: DocumentKind;
    assetId: string;
    createdBy: string;
    source?: DocumentVersionRow["source"];
    notes?: string;
  },
  now: number = Date.now(),
): { document: DocumentRow; version: DocumentVersionRow } {
  return db.transaction(() => {
    const last = db
      .select({ m: max(documents.sortOrder) })
      .from(documents)
      .where(and(eq(documents.projectId, input.projectId), isNull(documents.deletedAt)))
      .get();
    const document = db
      .insert(documents)
      .values({
        id: uuidv7(now),
        projectId: input.projectId,
        title: input.title.slice(0, 200),
        kind: input.kind,
        sortOrder: (last?.m ?? -1) + 1,
        createdBy: input.createdBy,
        createdAt: now,
      })
      .returning()
      .get();
    const version = db
      .insert(documentVersions)
      .values({
        id: uuidv7(now),
        documentId: document.id,
        number: 1,
        assetId: input.assetId,
        notes: input.notes ?? "",
        source: input.source ?? "upload",
        uploadedBy: input.createdBy,
        createdAt: now,
      })
      .returning()
      .get();
    const updated = db
      .update(documents)
      .set({ currentVersionId: version.id })
      .where(eq(documents.id, document.id))
      .returning()
      .get();
    touchProject(db, input.projectId, now);
    return { document: updated, version };
  });
}

/** Adds a version and makes it current (a new upload or a saved edit, SPEC §10). */
export function addDocumentVersion(
  db: Db,
  input: {
    documentId: string;
    assetId: string;
    uploadedBy: string;
    source: DocumentVersionRow["source"];
    notes?: string;
  },
  now: number = Date.now(),
): { document: DocumentRow; version: DocumentVersionRow } {
  return db.transaction(() => {
    const last = db
      .select({ m: max(documentVersions.number) })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, input.documentId))
      .get();
    const version = db
      .insert(documentVersions)
      .values({
        id: uuidv7(now),
        documentId: input.documentId,
        number: (last?.m ?? 0) + 1,
        assetId: input.assetId,
        notes: input.notes ?? "",
        source: input.source,
        uploadedBy: input.uploadedBy,
        createdAt: now,
      })
      .returning()
      .get();
    const document = db
      .update(documents)
      .set({ currentVersionId: version.id })
      .where(eq(documents.id, input.documentId))
      .returning()
      .get();
    touchProject(db, document.projectId, now);
    return { document, version };
  });
}

/** A live document (not deleted) or undefined. */
export function getDocumentRow(db: Db, id: string): DocumentRow | undefined {
  return db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
    .get();
}

/** Any document row, including soft-deleted ones (restore). */
export function getDocumentRowAny(db: Db, id: string): DocumentRow | undefined {
  return db.select().from(documents).where(eq(documents.id, id)).get();
}

export function getDocumentVersionRow(db: Db, id: string): DocumentVersionRow | undefined {
  return db.select().from(documentVersions).where(eq(documentVersions.id, id)).get();
}

/** Where a document lives, for scope resolution (deleted documents included, for restore). */
export function documentLocation(
  db: Db,
  id: string,
): { documentId: string; projectId: string } | undefined {
  const d = db
    .select({ id: documents.id, projectId: documents.projectId })
    .from(documents)
    .where(eq(documents.id, id))
    .get();
  return d && { documentId: d.id, projectId: d.projectId };
}

export function documentLocationOfVersion(
  db: Db,
  versionId: string,
): { documentId: string; projectId: string } | undefined {
  const v = getDocumentVersionRow(db, versionId);
  return v && documentLocation(db, v.documentId);
}

/** The project's live documents, in order. */
export function listDocuments(db: Db, projectId: string): DocumentRow[] {
  return db
    .select()
    .from(documents)
    .where(and(eq(documents.projectId, projectId), isNull(documents.deletedAt)))
    .orderBy(documents.sortOrder, documents.createdAt)
    .all();
}

/** Live versions, newest first. */
export function listDocumentVersionRows(db: Db, documentId: string): DocumentVersionRow[] {
  return db
    .select()
    .from(documentVersions)
    .where(and(eq(documentVersions.documentId, documentId), isNull(documentVersions.deletedAt)))
    .orderBy(desc(documentVersions.number))
    .all();
}

export function countDocumentVersions(db: Db, documentIds: readonly string[]): Map<string, number> {
  if (documentIds.length === 0) return new Map();
  const rows = db
    .select({ id: documentVersions.documentId, n: sql<number>`count(*)` })
    .from(documentVersions)
    .where(
      and(
        inArray(documentVersions.documentId, [...documentIds]),
        isNull(documentVersions.deletedAt),
      ),
    )
    .groupBy(documentVersions.documentId)
    .all();
  return new Map(rows.map((r) => [r.id, r.n]));
}

export function updateDocumentRow(
  db: Db,
  id: string,
  patch: { title?: string; kind?: DocumentKind },
): DocumentRow | undefined {
  if (Object.keys(patch).length === 0) return getDocumentRow(db, id);
  return db
    .update(documents)
    .set({ ...patch, ...(patch.title !== undefined && { title: patch.title.slice(0, 200) }) })
    .where(eq(documents.id, id))
    .returning()
    .get();
}

export function setCurrentDocumentVersionRow(
  db: Db,
  documentId: string,
  versionId: string,
): DocumentRow {
  return db
    .update(documents)
    .set({ currentVersionId: versionId })
    .where(eq(documents.id, documentId))
    .returning()
    .get();
}

/** Moves a document to the Trash (with who did it), or back (`deletedAt` null). */
export function setDocumentDeleted(
  db: Db,
  id: string,
  deletedAt: number | null,
  deletedBy: string | null = null,
): DocumentRow {
  return db
    .update(documents)
    .set({ deletedAt, deletedBy: deletedAt === null ? null : deletedBy })
    .where(eq(documents.id, id))
    .returning()
    .get();
}

/**
 * Soft-deletes one version; when it was current, the newest remaining version becomes current.
 * Returns the updated document.
 */
export function softDeleteDocumentVersion(
  db: Db,
  versionId: string,
  now: number = Date.now(),
): DocumentRow {
  return db.transaction(() => {
    const v = db
      .update(documentVersions)
      .set({ deletedAt: now })
      .where(eq(documentVersions.id, versionId))
      .returning()
      .get();
    let doc = db.select().from(documents).where(eq(documents.id, v.documentId)).get();
    if (!doc) throw new Error("document missing");
    if (doc.currentVersionId === versionId) {
      const next = listDocumentVersionRows(db, v.documentId)[0];
      doc = setCurrentDocumentVersionRow(db, v.documentId, next?.id ?? versionId);
    }
    return doc;
  });
}

export function restoreDocumentVersionRow(db: Db, versionId: string): DocumentVersionRow {
  return db
    .update(documentVersions)
    .set({ deletedAt: null })
    .where(eq(documentVersions.id, versionId))
    .returning()
    .get();
}

/**
 * Document versions whose file has not been through `document.ingest` yet (no probe), e.g.
 * documents imported from Samply before M9. Used to enqueue a one-time backfill.
 */
export function documentVersionsWithoutProbe(db: Db): {
  versionId: string;
  assetId: string;
  documentId: string;
  projectId: string;
}[] {
  return db
    .select({
      versionId: documentVersions.id,
      assetId: documentVersions.assetId,
      documentId: documents.id,
      projectId: documents.projectId,
    })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .innerJoin(assets, eq(assets.id, documentVersions.assetId))
    .where(
      and(
        isNull(assets.probe),
        eq(assets.kind, "document"),
        eq(assets.status, "ready"),
        isNull(documentVersions.deletedAt),
        isNull(documents.deletedAt),
      ),
    )
    .all();
}

/** Assets referenced by live document versions (blob access). */
export function documentReferrersOfAsset(db: Db, assetId: string): { projectId: string }[] {
  return db
    .select({ projectId: documents.projectId })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(
      and(
        eq(documentVersions.assetId, assetId),
        isNull(documentVersions.deletedAt),
        isNull(documents.deletedAt),
      ),
    )
    .all();
}
