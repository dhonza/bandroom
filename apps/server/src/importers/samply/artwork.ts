import path from "node:path";
import {
  createOriginalAsset,
  enqueueProjectImageIngest,
  schema,
  storeFile,
  updateProjectRow,
  type JobContext,
} from "@bandroom/server-core";
import type { ImportProject } from "@bandroom/shared";
import { eq } from "drizzle-orm";
import type { SamplyClient } from "./api";
import type { Reporter } from "./report";
import { IMPORT_JOB_PRIORITY, ImportDiskFull } from "./runState";

/**
 * The project picture. Samply's artwork URL is a signed-only CDN link the API key cannot fetch,
 * so the picture comes from the file box Samply keeps for it (downloaded via the API). Also fills
 * in a missing image on a project imported earlier; never replaces an existing one.
 */
export async function importArtwork(
  ctx: JobContext,
  client: SamplyClient,
  project: ImportProject,
  projectId: string,
  admin: string,
  rep: Reporter,
): Promise<void> {
  const row = ctx.db
    .select({ image: schema.projects.imageAssetId })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  if (!row || row.image) return;
  const box = project.nodes.find((n) => n.isArtwork);
  const file = box?.versions.at(-1);
  if (!file) {
    if (project.artworkUrl)
      rep.log(
        "Project picture is not available through the Samply API; set it in project settings.",
      );
    return;
  }
  try {
    const { url } = await client.downloadUrl(project.samplyId, file.id);
    const dest = path.join(ctx.tmpDir, `artwork-${projectId}`);
    const dl = await client.download(url, dest);
    const blob = await storeFile(ctx.db, ctx.storage, dest, dl.sha256);
    const asset = createOriginalAsset(
      ctx.db,
      {
        kind: "image",
        originalFilename: file.name,
        mimeType: dl.contentType ?? undefined,
        sizeBytes: dl.sizeBytes,
        originalHash: dl.sha256,
        uploadedBy: admin,
      },
      blob,
    );
    updateProjectRow(ctx.db, projectId, { imageAssetId: asset.id });
    enqueueProjectImageIngest(ctx.db, {
      assetId: asset.id,
      projectId,
      createdBy: admin,
      priority: IMPORT_JOB_PRIORITY,
    });
    ctx.emit({ type: "project.updated", projectId, data: { projectId } });
    rep.log(`Project picture imported (${file.name})`);
  } catch (err) {
    if (ctx.signal.aborted || err instanceof ImportDiskFull) throw err;
    rep.log(`Project picture skipped: ${String(err).slice(0, 200)}`);
  }
}
