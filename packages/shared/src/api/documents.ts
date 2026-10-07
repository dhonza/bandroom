import { z } from "zod";
import {
  DOCUMENT_TEXT_MAX,
  DocumentSchema,
  DocumentTitleSchema,
  DocumentVersionSchema,
} from "../documents";
import { OkSchema } from "./auth";
import { defineContract } from "./contract";

/**
 * Documents (SPEC §10, §28.4): project documents with version stacks. File uploads use
 * the tus targets `newDocument` / `documentVersion`; the file itself is read through
 * `GET /document-versions/:id/content` (viewing) and `…/download` (download policy).
 */

const IdParams = z.object({ id: z.string().min(1).max(64) });
const DocumentText = z.string().max(DOCUMENT_TEXT_MAX);

/**
 * The project's documents (SPEC §10, §28.4); empty in the reduced view (SPEC §3.3).
 */
export const listProjectDocuments = defineContract({
  method: "GET",
  path: "/projects/:id/documents",
  params: IdParams,
  response: z.object({ documents: z.array(DocumentSchema) }),
  auth: { capability: "view", scope: "project" },
});

const NewTextDocumentBody = z.object({
  title: DocumentTitleSchema,
  kind: z.enum(["markdown", "text"]),
  text: DocumentText,
});

/** A new Markdown/text document written in the app (SPEC §10 Markdown editing). */
export const createProjectTextDocument = defineContract({
  method: "POST",
  path: "/projects/:id/documents",
  params: IdParams,
  body: NewTextDocumentBody,
  response: z.object({ document: DocumentSchema }),
  errors: ["QUOTA_EXCEEDED", "DISK_FULL"],
  auth: { capability: "upload", scope: "project" },
});

export const getDocument = defineContract({
  method: "GET",
  path: "/documents/:id",
  params: IdParams,
  response: z.object({ document: DocumentSchema }),
  auth: { capability: "view", scope: "document" },
});

/** Rename: the creator (contributor+) or an editor (SPEC §3.2 edit.own/any). */
export const updateDocument = defineContract({
  method: "PATCH",
  path: "/documents/:id",
  params: IdParams,
  body: z.object({ title: DocumentTitleSchema }),
  response: z.object({ document: DocumentSchema }),
  errors: ["FORBIDDEN"],
  auth: { capability: "edit.own", scope: "document" },
});

/** Soft delete with undo (SPEC §11.1): the creator (contributor+) or an editor. */
export const deleteDocument = defineContract({
  method: "DELETE",
  path: "/documents/:id",
  params: IdParams,
  response: OkSchema,
  errors: ["FORBIDDEN"],
  auth: { capability: "delete.own", scope: "document" },
});

export const restoreDocument = defineContract({
  method: "POST",
  path: "/documents/:id/restore",
  params: IdParams,
  response: z.object({ document: DocumentSchema }),
  errors: ["FORBIDDEN"],
  auth: { capability: "delete.own", scope: "document" },
});

export const listDocumentVersions = defineContract({
  method: "GET",
  path: "/documents/:id/versions",
  params: IdParams,
  response: z.object({ versions: z.array(DocumentVersionSchema) }),
  auth: { capability: "view", scope: "document" },
});

/**
 * Saves edited Markdown/text as a new version (SPEC §10: contributor+ own, editor+ any).
 * `baseVersionId` is the version the edit started from; if another version became current in
 * the meantime the save is refused with EDIT_CONFLICT.
 */
export const saveDocumentText = defineContract({
  method: "POST",
  path: "/documents/:id/versions",
  params: IdParams,
  body: z.object({
    text: DocumentText,
    notes: z.string().trim().max(500).optional(),
    baseVersionId: z.string().min(1).max(64).nullable(),
  }),
  response: z.object({ document: DocumentSchema }),
  errors: ["FORBIDDEN", "EDIT_CONFLICT", "BAD_REQUEST", "QUOTA_EXCEEDED", "DISK_FULL"],
  auth: { capability: "edit.own", scope: "document" },
});

/** Makes an older version current again (editor action, like tracks). */
export const setCurrentDocumentVersion = defineContract({
  method: "POST",
  path: "/documents/:id/current",
  params: IdParams,
  body: z.object({ versionId: z.string().min(1).max(64) }),
  response: z.object({ document: DocumentSchema }),
  errors: ["NOT_FOUND"],
  auth: { capability: "version.setCurrent", scope: "document" },
});

/** Soft delete of one version (uploader or editor); the last version cannot be deleted. */
export const deleteDocumentVersion = defineContract({
  method: "DELETE",
  path: "/document-versions/:id",
  params: IdParams,
  response: OkSchema,
  errors: ["FORBIDDEN", "BAD_REQUEST"],
  auth: { capability: "delete.own", scope: "documentVersion" },
});

export const restoreDocumentVersion = defineContract({
  method: "POST",
  path: "/document-versions/:id/restore",
  params: IdParams,
  response: OkSchema,
  errors: ["FORBIDDEN"],
  auth: { capability: "delete.own", scope: "documentVersion" },
});

/** Re-runs a failed `document.ingest` (uploader or editor). */
export const retryDocumentVersion = defineContract({
  method: "POST",
  path: "/document-versions/:id/retry",
  params: IdParams,
  response: OkSchema,
  errors: ["FORBIDDEN", "BAD_REQUEST"],
  auth: { capability: "edit.own", scope: "documentVersion" },
});
