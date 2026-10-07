import {
  addDocumentVersion,
  createOriginalAsset,
  createDocumentWithVersion,
  enqueueDocumentIngest,
  completeUploadSession,
  recordEvent,
  type UserRow,
} from "@bandroom/server-core";
import {
  documentKindFromName,
  documentTitleFromFilename,
  type UploadResult,
  type UploadTarget,
} from "@bandroom/shared";
import type { AppContext } from "../../context";
import { publishDocumentChanged } from "../../documents";
import type { ScopeAccess } from "../../http/scope";
import { notifyDocument, notifyQuotaFor } from "../../notify";
import { ipOf } from "./tusSupport";

/** Upload of a new document or a new document version (SPEC §10): ingest detects the kind. */
export async function finishDocumentUpload(
  ctx: AppContext,
  req: Request,
  user: UserRow,
  access: ScopeAccess,
  u: {
    target: Extract<UploadTarget, { type: "newDocument" | "documentVersion" }>;
    uploadId: string;
    filename: string;
    blob: { hash: string; sizeBytes: number };
    discard: () => Promise<void>;
  },
): Promise<UploadResult> {
  const { db } = ctx;
  const { target, filename, blob } = u;
  const now = Date.now();
  let r;
  try {
    r = db.transaction(() => {
      const asset = createOriginalAsset(
        db,
        {
          kind: "document",
          originalFilename: filename,
          sizeBytes: blob.sizeBytes,
          originalHash: blob.hash,
          uploadedBy: user.id,
        },
        blob,
        now,
      );
      completeUploadSession(db, u.uploadId, now);
      const created =
        target.type === "newDocument"
          ? createDocumentWithVersion(
              db,
              {
                projectId: target.projectId,
                title: target.title ?? documentTitleFromFilename(filename),
                kind: documentKindFromName(filename),
                assetId: asset.id,
                createdBy: user.id,
              },
              now,
            )
          : addDocumentVersion(
              db,
              {
                documentId: target.documentId,
                assetId: asset.id,
                uploadedBy: user.id,
                source: "upload",
              },
              now,
            );
      enqueueDocumentIngest(db, {
        assetId: asset.id,
        documentId: created.document.id,
        documentVersionId: created.version.id,
        projectId: created.document.projectId,
        createdBy: user.id,
      });
      recordEvent(db, {
        actorUserId: user.id,
        projectId: created.document.projectId,
        ip: ipOf(req),
        userAgent: req.headers.get("user-agent"),
        action: target.type === "newDocument" ? "document.created" : "document.version_added",
        targetType: "document",
        targetId: created.document.id,
        details: {
          versionId: created.version.id,
          number: created.version.number,
          assetId: asset.id,
          source: "upload",
        },
      });
      return { asset, ...created };
    });
  } catch (err) {
    await u.discard();
    throw err;
  }
  const { document, version } = r;
  notifyDocument(ctx, {
    actor: user,
    project: access.project,
    document,
    version,
  });
  notifyQuotaFor(ctx, user);
  publishDocumentChanged(ctx, { projectId: document.projectId, documentId: document.id });
  return {
    assetId: r.asset.id,
    trackId: null,
    trackVersionId: null,
    documentId: document.id,
    documentVersionId: version.id,
  };
}
