import type { Document, DocumentVersion } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { documentPermissions, editorDirty } from "./model";

const version = { id: "v1", kind: "markdown", status: "ready" } as DocumentVersion;

const doc = (over: Partial<Document>): Document =>
  ({
    id: "d1",
    kind: "markdown",
    current: version,
    canEdit: true,
    canDelete: true,
    canDownload: true,
    ...over,
  }) as Document;

describe("documentPermissions", () => {
  it("allows text editing only for ready Markdown/text versions the user may edit", () => {
    expect(documentPermissions(doc({}), true)).toEqual({
      canEditText: true,
      canRename: true,
      canDelete: true,
      canUpload: true,
      canDownload: true,
    });
    expect(documentPermissions(doc({ canEdit: false }), false)).toMatchObject({
      canEditText: false,
      canRename: false,
      canUpload: false,
    });
    const pdf = { ...version, kind: "pdf" } as DocumentVersion;
    expect(documentPermissions(doc({ current: pdf }), true).canEditText).toBe(false);
    const pending = { ...version, status: "processing" } as DocumentVersion;
    expect(documentPermissions(doc({ current: pending }), true).canEditText).toBe(false);
  });

  it("needs a current version to edit or download", () => {
    expect(documentPermissions(doc({ current: null }), true)).toMatchObject({
      canEditText: false,
      canDownload: false,
    });
    expect(documentPermissions(doc({ canDownload: false }), true).canDownload).toBe(false);
  });
});

describe("editorDirty", () => {
  it("is dirty only for a changed draft of a loaded text", () => {
    expect(editorDirty(true, "b", "a")).toBe(true);
    expect(editorDirty(true, "a", "a")).toBe(false);
    expect(editorDirty(true, null, "a")).toBe(false);
    expect(editorDirty(false, "b", undefined)).toBe(false);
  });
});
