import { isEditableKind, type Document } from "@bandroom/shared";

/** What the user may do with a document, from the list DTO (server-computed flags). */
export function documentPermissions(doc: Document, canUpload: boolean) {
  const kind = doc.current?.kind ?? doc.kind;
  return {
    canEditText: doc.canEdit && isEditableKind(kind) && doc.current?.status === "ready",
    canRename: doc.canEdit,
    canDelete: doc.canDelete,
    canUpload,
    canDownload: doc.canDownload && doc.current !== null,
  };
}

/**
 * The editor has unsaved changes. Only a successfully loaded text counts: saving over a failed
 * load would replace the document with whatever was typed into an empty box.
 */
export function editorDirty(loaded: boolean, draft: string | null, original: string | undefined) {
  return loaded && draft !== null && draft !== original;
}
