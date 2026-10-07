import { z } from "zod";
import { AssetStatusSchema } from "./tracks";

/** Document kinds (SPEC §4.2, §5.2). Detected by content in `document.ingest` (SPEC §5.7). */
export const DOCUMENT_KINDS = ["markdown", "text", "pdf", "image", "midi", "other"] as const;
export const DocumentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

/** Kinds that can be edited in the app (SPEC §10 "Markdown editing"). */
export const EDITABLE_DOCUMENT_KINDS = ["markdown", "text"] as const satisfies DocumentKind[];
export type EditableDocumentKind = (typeof EDITABLE_DOCUMENT_KINDS)[number];

export function isEditableKind(kind: DocumentKind): kind is EditableDocumentKind {
  return kind === "markdown" || kind === "text";
}

/** Largest document text edited or created in the app (characters). */
export const DOCUMENT_TEXT_MAX = 1_000_000;
/** Text documents larger than this are offered as a download instead of rendered. */
export const DOCUMENT_TEXT_VIEW_MAX_BYTES = 2 * 1024 * 1024;

/** Font-size slider of the Markdown/text viewer (SPEC §10), px. */
export const DOC_FONT_MIN = 12;
export const DOC_FONT_MAX = 40;
export const DOC_FONT_DEFAULT = 18;
export const DocFontSizeSchema = z.number().int().min(DOC_FONT_MIN).max(DOC_FONT_MAX);

export const DocumentTitleSchema = z.string().trim().min(1).max(200);

/** Kind guessed from the file name only (used before the content is known). */
export function documentKindFromName(name: string): DocumentKind {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (["txt", "text", "cho", "chordpro", "crd", "chopro"].includes(ext)) return "text";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "avif"].includes(ext)) return "image";
  if (ext === "mid" || ext === "midi") return "midi";
  return "other";
}

/** A document title from a file name: extension removed ("Lyrics v2.md" → "Lyrics v2"). */
export function documentTitleFromFilename(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim();
  return (base || name.trim() || "Document").slice(0, 200);
}

/** What `document.ingest` found out about a version's file (stored as the asset's probe). */
export const DocumentProbeSchema = z.object({
  kind: DocumentKindSchema,
  /** PDF page count. */
  pages: z.number().int().nullable().optional(),
  /** Image size in px. */
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  /** Why a preview is missing (e.g. "not UTF-8", "unreadable PDF"). */
  note: z.string().nullable().optional(),
});
export type DocumentProbe = z.infer<typeof DocumentProbeSchema>;

export const DocumentVersionSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  number: z.number(),
  notes: z.string(),
  source: z.enum(["upload", "import", "edit"]),
  createdAt: z.number(),
  uploadedBy: z.string().nullable(),
  uploaderName: z.string().nullable(),
  originalFilename: z.string(),
  sizeBytes: z.number(),
  status: AssetStatusSchema,
  error: z.string().nullable(),
  /** Detected kind of this version's file (the document's kind follows the current version). */
  kind: DocumentKindSchema,
  pages: z.number().nullable(),
  /** WebP thumbnail (PDF first page, images), 256 px. */
  thumbHash: z.string().nullable(),
  /** Large WebP rendition for the image viewer (≤ 2048 px). */
  previewHash: z.string().nullable(),
  isCurrent: z.boolean(),
  /** Whether the current user may delete this version (uploader or editor). */
  canDelete: z.boolean(),
});
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

export const DocumentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Null = project-level document. */
  songId: z.string().nullable(),
  songTitle: z.string().nullable(),
  title: z.string(),
  kind: DocumentKindSchema,
  sortOrder: z.number(),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  versionCount: z.number(),
  current: DocumentVersionSchema.nullable(),
  /** Whether the current user may download the files (download policy, SPEC §3.4, §10). */
  canDownload: z.boolean(),
  /** Whether the current user may rename, edit the text of, or delete this document. */
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  /** Editors may make an older version current. */
  canSetCurrent: z.boolean(),
});
export type Document = z.infer<typeof DocumentSchema>;
