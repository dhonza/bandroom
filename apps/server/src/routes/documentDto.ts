import {
  countDocumentVersions,
  getAsset,
  getDocumentVersionRow,
  getUserById,
  listVariants,
  type Db,
  type DocumentRow,
  type DocumentVersionRow,
  type ProjectRow,
} from "@bandroom/server-core";
import {
  canActOn,
  DocumentProbeSchema,
  hasCapability,
  type Document,
  type DocumentVersion,
  type EffectiveRole,
} from "@bandroom/shared";
import { documentDownloadAllowed } from "../http/scope";

/** The viewer's relation to a document's project. */
export interface DocumentViewer {
  userId: string;
  role: EffectiveRole;
  project: ProjectRow;
}

function probeOf(raw: string | null) {
  if (!raw) return null;
  try {
    const r = DocumentProbeSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function toDocumentVersion(
  db: Db,
  v: DocumentVersionRow,
  doc: DocumentRow,
  viewer: Pick<DocumentViewer, "userId" | "role">,
): DocumentVersion {
  const asset = getAsset(db, v.assetId);
  const vars = new Map(listVariants(db, v.assetId).map((x) => [x.variant, x.blobHash]));
  const probe = probeOf(asset?.probe ?? null);
  return {
    id: v.id,
    documentId: v.documentId,
    number: v.number,
    notes: v.notes,
    source: v.source,
    createdAt: v.createdAt,
    uploadedBy: v.uploadedBy,
    uploaderName: v.uploadedBy ? (getUserById(db, v.uploadedBy)?.displayName ?? null) : null,
    originalFilename: asset?.originalFilename ?? "",
    sizeBytes: asset?.sizeBytes ?? 0,
    status: asset?.status ?? "failed",
    error: asset?.error ?? null,
    kind: probe?.kind ?? doc.kind,
    pages: probe?.pages ?? null,
    thumbHash: vars.get("webp_256") ?? null,
    previewHash: vars.get("webp_2048") ?? null,
    isCurrent: doc.currentVersionId === v.id,
    canDelete: canActOn(viewer.role, "delete", v.uploadedBy === viewer.userId),
  };
}

export function toDocument(
  db: Db,
  doc: DocumentRow,
  viewer: DocumentViewer,
  versionCount?: number,
): Document {
  const current = doc.currentVersionId ? getDocumentVersionRow(db, doc.currentVersionId) : null;
  const own = doc.createdBy === viewer.userId;
  return {
    id: doc.id,
    projectId: doc.projectId,
    title: doc.title,
    kind: doc.kind,
    sortOrder: doc.sortOrder,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    versionCount: versionCount ?? countDocumentVersions(db, [doc.id]).get(doc.id) ?? 0,
    current: current && !current.deletedAt ? toDocumentVersion(db, current, doc, viewer) : null,
    canDownload: documentDownloadAllowed(viewer),
    canEdit: canActOn(viewer.role, "edit", own),
    canDelete: canActOn(viewer.role, "delete", own),
    canSetCurrent: hasCapability(viewer.role, "version.setCurrent"),
  };
}

export function toDocuments(db: Db, rows: readonly DocumentRow[], viewer: DocumentViewer) {
  const counts = countDocumentVersions(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toDocument(db, r, viewer, counts.get(r.id) ?? 0));
}
