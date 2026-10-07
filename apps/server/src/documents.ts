import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createOriginalAsset,
  storeFile,
  schema,
  type AssetRow,
  type UserRow,
} from "@bandroom/server-core";
import type { DocumentProbe, EditableDocumentKind } from "@bandroom/shared";
import { eq } from "drizzle-orm";
import type { AppContext } from "./context";
import { checkQuotaAndDisk } from "./quota";

type Ctx = Pick<AppContext, "db" | "hub" | "storage" | "config">;

/**
 * Stores Markdown/text written in the app as a ready document asset (UTF-8, as-is; SPEC §5.7).
 * No ingest job is needed: the kind is known and there is no preview.
 */
export async function storeTextAsset(
  ctx: Ctx,
  user: UserRow,
  input: { text: string; filename: string; kind: EditableDocumentKind },
): Promise<AssetRow> {
  const data = Buffer.from(input.text, "utf8");
  await checkQuotaAndDisk(ctx, user, data.length);
  const dir = path.join(ctx.config.tmpDir, "documents");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.txt`);
  await fs.writeFile(file, data);
  try {
    const blob = await storeFile(ctx.db, ctx.storage, file);
    const probe: DocumentProbe = { kind: input.kind };
    return ctx.db.transaction(() => {
      const asset = createOriginalAsset(
        ctx.db,
        {
          kind: "document",
          originalFilename: input.filename,
          mimeType: input.kind === "markdown" ? "text/markdown" : "text/plain",
          sizeBytes: blob.sizeBytes,
          originalHash: blob.hash,
          uploadedBy: user.id,
        },
        blob,
      );
      return ctx.db
        .update(schema.assets)
        .set({ status: "ready", probe: JSON.stringify(probe) })
        .where(eq(schema.assets.id, asset.id))
        .returning()
        .get();
    });
  } finally {
    await fs.rm(file, { force: true });
  }
}

/** File name for a text version written in the app ("Lyrics.md"). */
export function textFilename(title: string, kind: EditableDocumentKind): string {
  // eslint-disable-next-line no-control-regex -- control characters are not allowed in names
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "document";
  return `${safe.slice(0, 120)}.${kind === "markdown" ? "md" : "txt"}`;
}

/** SSE: something about a document changed (list, versions, processing state). */
export function publishDocumentChanged(
  ctx: Pick<AppContext, "hub">,
  scope: { projectId: string; songId: string | null; documentId: string },
): void {
  ctx.hub.publish({
    type: "document.changed",
    projectId: scope.projectId,
    songId: scope.songId,
    data: { documentId: scope.documentId },
  });
}
