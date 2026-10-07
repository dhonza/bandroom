import {
  addDocumentVersion,
  createDocumentWithVersion,
  enqueueDocumentIngest,
  getAsset,
  getDocumentRow,
  getDocumentRowAny,
  getDocumentVersionRow,
  getVariant,
  listDocuments,
  listDocumentsOfSongs,
  listDocumentVersionRows,
  listVisibleSongs,
  restoreDocumentVersionRow,
  setAssetStatus,
  setCurrentDocumentVersionRow,
  setDocumentDeleted,
  softDeleteDocumentVersion,
  updateDocumentRow,
  type DocumentRow,
  type UserRow,
} from "@bandroom/server-core";
import {
  canActOn,
  createProjectTextDocument,
  createSongTextDocument,
  deleteDocument,
  deleteDocumentVersion,
  DocumentProbeSchema,
  getDocument,
  listDocumentVersions,
  listProjectDocuments,
  listSongDocuments,
  restoreDocument,
  restoreDocumentVersion,
  retryDocumentVersion,
  saveDocumentText,
  setCurrentDocumentVersion,
  updateDocument,
  type DocumentKind,
  type EditableDocumentKind,
} from "@bandroom/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { publishDocumentChanged, storeTextAsset, textFilename } from "../documents";
import { audit } from "../http/audit";
import { contentDisposition, sendBlob } from "../http/blobs";
import { BoundedRecent } from "../http/boundedRecent";
import { registerAuthorizedRoute, registerContract } from "../http/contracts";
import { AppError } from "../http/errors";
import type { DocumentScopeAccess } from "../http/scope";
import { notifyDocument, notifyQuotaFor } from "../notify";
import { toDocument, toDocuments, toDocumentVersion, type DocumentViewer } from "./documentDto";

/** JSON bodies with document text (≤ 1 M characters of UTF-8). */
const TEXT_BODY_LIMIT = 5 * 1024 * 1024;

/** One `document.viewed` per user and version within this window (the viewer refetches). */
const VIEW_LOG_WINDOW_MS = 10 * 60_000;
const VIEW_LOG_MAX = 5000;

/** Safe content types for in-app viewing: never HTML (SPEC §18.6). */
function contentTypeFor(kind: DocumentKind): string {
  return kind === "markdown" || kind === "text"
    ? "text/plain; charset=utf-8"
    : "application/octet-stream";
}

function kindOfVersion(ctx: AppContext, assetId: string, doc: DocumentRow): DocumentKind {
  const asset = getAsset(ctx.db, assetId);
  if (!asset?.probe) return doc.kind;
  try {
    const r = DocumentProbeSchema.safeParse(JSON.parse(asset.probe));
    return r.success ? r.data.kind : doc.kind;
  } catch {
    return doc.kind;
  }
}

function viewerOf(user: UserRow, access: Omit<DocumentViewer, "userId">): DocumentViewer {
  return { userId: user.id, role: access.role, project: access.project, song: access.song };
}

export function registerDocumentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  // Bounded memory of recent views, so re-renders and Range requests do not flood the log.
  const views = new BoundedRecent(VIEW_LOG_WINDOW_MS, VIEW_LOG_MAX);

  const liveDocument = (access: DocumentScopeAccess): DocumentRow => {
    const doc = getDocumentRow(db, access.documentId);
    if (!doc) throw new AppError("NOT_FOUND", "Document not found");
    return doc;
  };
  const event = (
    request: FastifyRequest,
    access: { project: { id: string }; song: { id: string } | null },
    action: Parameters<typeof audit>[2]["action"],
    doc: DocumentRow,
    details?: Record<string, unknown>,
  ) => {
    audit(db, request, {
      action,
      projectId: access.project.id,
      songId: access.song?.id ?? null,
      targetType: "document",
      targetId: doc.id,
      ...(details && { details }),
    });
    publishDocumentChanged(ctx, {
      projectId: doc.projectId,
      songId: doc.songId,
      documentId: doc.id,
    });
  };

  // --- Lists ----------------------------------------------------------------------------------

  registerContract(app, listSongDocuments, ({ user, access }) => ({
    documents: toDocuments(db, listDocuments(db, access.project.id, access.song.id), {
      userId: user.id,
      role: access.role,
      project: access.project,
      song: access.song,
    }),
  }));

  registerContract(app, listProjectDocuments, ({ user, access }) => {
    // Project-level documents need `viewer` on the project; the reduced view has none (§3.3).
    const own =
      access.visibility === "full"
        ? toDocuments(db, listDocuments(db, access.project.id, null), {
            userId: user.id,
            role: access.role,
            project: access.project,
            song: null,
          })
        : [];
    const visible = listVisibleSongs(db, user, access.project.id);
    const rows = listDocumentsOfSongs(
      db,
      visible.map((s) => s.song.id),
    );
    const songs = visible.flatMap(({ song, role }) => {
      const docs = rows.filter((d) => d.songId === song.id);
      return docs.length === 0
        ? []
        : [
            {
              songId: song.id,
              songTitle: song.title,
              documents: toDocuments(db, docs, {
                userId: user.id,
                role,
                project: access.project,
                song,
              }),
            },
          ];
    });
    return { documents: own, songs };
  });

  // --- Text documents written in the app ------------------------------------------------------

  const createText = async (
    request: FastifyRequest,
    user: UserRow,
    scope: DocumentViewer,
    body: { title: string; kind: EditableDocumentKind; text: string },
  ) => {
    const asset = await storeTextAsset(ctx, user, {
      text: body.text,
      filename: textFilename(body.title, body.kind),
      kind: body.kind,
    });
    const { document, version } = createDocumentWithVersion(db, {
      projectId: scope.project.id,
      songId: scope.song?.id ?? null,
      title: body.title,
      kind: body.kind,
      assetId: asset.id,
      createdBy: user.id,
      source: "edit",
    });
    event(request, scope, "document.created", document, {
      versionId: version.id,
      number: 1,
      source: "edit",
    });
    notifyDocument(ctx, {
      actor: user,
      project: scope.project,
      song: scope.song,
      document,
      version,
    });
    notifyQuotaFor(ctx, user);
    return { document: toDocument(db, document, scope) };
  };

  registerContract(
    app,
    createSongTextDocument,
    ({ user, access, body }, request) =>
      createText(request, user, viewerOf(user, { ...access, song: access.song }), body),
    { bodyLimit: TEXT_BODY_LIMIT },
  );
  registerContract(
    app,
    createProjectTextDocument,
    ({ user, access, body }, request) =>
      createText(request, user, viewerOf(user, { ...access, song: null }), body),
    { bodyLimit: TEXT_BODY_LIMIT },
  );

  // --- One document ---------------------------------------------------------------------------

  registerContract(app, getDocument, ({ user, access }) => ({
    document: toDocument(db, liveDocument(access), viewerOf(user, access)),
  }));

  registerContract(app, updateDocument, ({ user, access, body }, request) => {
    const doc = liveDocument(access);
    if (!canActOn(access.role, "edit", doc.createdBy === user.id))
      throw new AppError("FORBIDDEN", "Only the creator or an editor may rename this document");
    const updated = updateDocumentRow(db, doc.id, { title: body.title }) ?? doc;
    event(request, access, "document.updated", updated, { title: body.title });
    return { document: toDocument(db, updated, viewerOf(user, access)) };
  });

  registerContract(app, deleteDocument, ({ user, access }, request) => {
    const doc = liveDocument(access);
    if (!canActOn(access.role, "delete", doc.createdBy === user.id))
      throw new AppError("FORBIDDEN", "Only the creator or an editor may delete this document");
    const deleted = setDocumentDeleted(db, doc.id, Date.now(), user.id);
    event(request, access, "document.deleted", deleted, { title: doc.title });
    return { ok: true as const };
  });

  registerContract(app, restoreDocument, ({ user, access }, request) => {
    const doc = getDocumentRowAny(db, access.documentId);
    if (!doc) throw new AppError("NOT_FOUND", "Document not found");
    if (!canActOn(access.role, "delete", doc.createdBy === user.id))
      throw new AppError("FORBIDDEN", "Only the creator or an editor may restore this document");
    const restored = doc.deletedAt === null ? doc : setDocumentDeleted(db, doc.id, null);
    if (doc.deletedAt !== null) event(request, access, "document.restored", restored);
    return { document: toDocument(db, restored, viewerOf(user, access)) };
  });

  // --- Versions -------------------------------------------------------------------------------

  registerContract(app, listDocumentVersions, ({ user, access }) => {
    const doc = liveDocument(access);
    const viewer = { userId: user.id, role: access.role };
    return {
      versions: listDocumentVersionRows(db, doc.id).map((v) =>
        toDocumentVersion(db, v, doc, viewer),
      ),
    };
  });

  registerContract(
    app,
    saveDocumentText,
    async ({ user, access, body }, request) => {
      const doc = liveDocument(access);
      if (!canActOn(access.role, "edit", doc.createdBy === user.id))
        throw new AppError("FORBIDDEN", "Only the creator or an editor may edit this document");
      const current = doc.currentVersionId ? getDocumentVersionRow(db, doc.currentVersionId) : null;
      const kind = current ? kindOfVersion(ctx, current.assetId, doc) : doc.kind;
      if (kind !== "markdown" && kind !== "text")
        throw new AppError("BAD_REQUEST", "Only Markdown and text documents can be edited");
      if (body.baseVersionId !== (doc.currentVersionId ?? null))
        throw new AppError("EDIT_CONFLICT", "The document was changed meanwhile");
      const asset = await storeTextAsset(ctx, user, {
        text: body.text,
        filename: textFilename(doc.title, kind),
        kind,
      });
      const { document, version } = addDocumentVersion(db, {
        documentId: doc.id,
        assetId: asset.id,
        uploadedBy: user.id,
        source: "edit",
        ...(body.notes && { notes: body.notes }),
      });
      event(request, access, "document.version_added", document, {
        versionId: version.id,
        number: version.number,
        source: "edit",
      });
      notifyDocument(ctx, {
        actor: user,
        project: access.project,
        song: access.song,
        document,
        version,
      });
      notifyQuotaFor(ctx, user);
      return { document: toDocument(db, document, viewerOf(user, access)) };
    },
    { bodyLimit: TEXT_BODY_LIMIT },
  );

  registerContract(app, setCurrentDocumentVersion, ({ user, access, body }, request) => {
    const doc = liveDocument(access);
    const v = getDocumentVersionRow(db, body.versionId);
    if (!v || v.documentId !== doc.id || v.deletedAt !== null)
      throw new AppError("NOT_FOUND", "Version not found");
    let updated = setCurrentDocumentVersionRow(db, doc.id, v.id);
    const kind = kindOfVersion(ctx, v.assetId, updated);
    if (kind !== updated.kind) updated = updateDocumentRow(db, doc.id, { kind }) ?? updated;
    event(request, access, "document.set_current", updated, { versionId: v.id, number: v.number });
    return { document: toDocument(db, updated, viewerOf(user, access)) };
  });

  const versionOf = (access: DocumentScopeAccess) => {
    const v = getDocumentVersionRow(db, access.targetId);
    if (!v) throw new AppError("NOT_FOUND", "Version not found");
    return { v, doc: liveDocument(access) };
  };

  registerContract(app, deleteDocumentVersion, ({ user, access }, request) => {
    const { v, doc } = versionOf(access);
    if (v.deletedAt !== null) return { ok: true as const };
    if (!canActOn(access.role, "delete", v.uploadedBy === user.id))
      throw new AppError("FORBIDDEN", "Only the uploader or an editor may delete this version");
    if (listDocumentVersionRows(db, doc.id).length <= 1)
      throw new AppError("BAD_REQUEST", "The only version cannot be deleted");
    const updated = softDeleteDocumentVersion(db, v.id);
    event(request, access, "document.version_deleted", updated, {
      versionId: v.id,
      number: v.number,
    });
    return { ok: true as const };
  });

  registerContract(app, restoreDocumentVersion, ({ user, access }, request) => {
    const { v, doc } = versionOf(access);
    if (!canActOn(access.role, "delete", v.uploadedBy === user.id))
      throw new AppError("FORBIDDEN", "Only the uploader or an editor may restore this version");
    if (v.deletedAt === null) return { ok: true as const };
    restoreDocumentVersionRow(db, v.id);
    // The restored version was probably current before the delete (undo): make it current again
    // when it is the newest.
    const newest = listDocumentVersionRows(db, doc.id)[0];
    const updated = newest?.id === v.id ? setCurrentDocumentVersionRow(db, doc.id, v.id) : doc;
    event(request, access, "document.version_restored", updated, {
      versionId: v.id,
      number: v.number,
    });
    return { ok: true as const };
  });

  registerContract(app, retryDocumentVersion, ({ user, access }, request) => {
    const { v, doc } = versionOf(access);
    const asset = getAsset(db, v.assetId);
    if (!asset) throw new AppError("NOT_FOUND", "Version not found");
    if (!canActOn(access.role, "edit", v.uploadedBy === user.id))
      throw new AppError("FORBIDDEN", "Only the uploader or an editor may retry");
    if (asset.status !== "failed")
      throw new AppError("BAD_REQUEST", "Only failed versions can be retried");
    setAssetStatus(db, asset.id, "queued");
    enqueueDocumentIngest(db, {
      assetId: asset.id,
      documentId: doc.id,
      documentVersionId: v.id,
      projectId: doc.projectId,
      songId: doc.songId,
      createdBy: user.id,
    });
    event(request, access, "document.retried", doc, { versionId: v.id });
    return { ok: true as const };
  });

  // --- File content (viewer) and download (download policy) -----------------------------------

  const fileOf = (access: DocumentScopeAccess) => {
    const { v, doc } = versionOf(access);
    if (v.deletedAt !== null) throw new AppError("NOT_FOUND", "Version not found");
    const asset = getAsset(db, v.assetId);
    const original = asset && getVariant(db, asset.id, "original");
    if (!asset || !original) throw new AppError("NOT_FOUND", "File not found");
    return { v, doc, asset, hash: original.blobHash };
  };

  /**
   * The file for the in-app viewers (SPEC §10, §18.6): Markdown/text as text/plain, everything
   * else as an opaque octet stream (PDFs render only through pdf.js), sandboxed by CSP. Not
   * cached, so each view can be logged (once per user and version within 10 minutes).
   */
  registerAuthorizedRoute(
    app,
    {
      method: ["GET", "HEAD"],
      url: "/document-versions/:id/content",
      auth: { capability: "view", scope: "documentVersion" },
    },
    async (request, reply) => {
      const access = request.access as DocumentScopeAccess;
      const { v, doc, hash } = fileOf(access);
      const range = request.headers.range;
      const first = !range || /^bytes=0-/.test(range);
      const user = request.user;
      if (first && user && views.markIfNew(`${user.id}:${v.id}`, Date.now())) {
        audit(db, request, {
          action: "document.viewed",
          projectId: access.project.id,
          songId: access.song?.id ?? null,
          targetType: "document",
          targetId: doc.id,
          details: { versionId: v.id, number: v.number },
        });
      }
      reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
      return sendBlob(
        ctx,
        request,
        reply,
        hash,
        contentTypeFor(kindOfVersion(ctx, v.assetId, doc)),
        undefined,
        "private, no-cache",
      );
    },
  );

  registerAuthorizedRoute(
    app,
    {
      method: "GET",
      url: "/document-versions/:id/download",
      auth: { capability: "download", scope: "documentVersion" },
    },
    async (request, reply) => {
      const access = request.access as DocumentScopeAccess;
      const { v, doc, asset, hash } = fileOf(access);
      audit(db, request, {
        action: "document.downloaded",
        projectId: access.project.id,
        songId: access.song?.id ?? null,
        targetType: "document",
        targetId: doc.id,
        details: { versionId: v.id, number: v.number, bytes: asset.sizeBytes },
      });
      return sendBlob(
        ctx,
        request,
        reply,
        hash,
        "application/octet-stream",
        contentDisposition(asset.originalFilename || doc.title),
      );
    },
  );
}
