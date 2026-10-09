import type { DownloadPolicy, Project, ProjectSummary } from "@bandroom/shared";
import { PaletteColorSchema, uuidv7 } from "@bandroom/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { assetVariants, projectGrants, projects, users } from "../db/schema";
import { and } from "drizzle-orm";
import { accessOf, type ProjectRow } from "./access";
import type { EffectiveRole } from "@bandroom/shared";

/** Hash of the project's 512 px WebP image, once processed. */
export function projectImageHash(db: Db, p: ProjectRow): string | null {
  if (!p.imageAssetId) return null;
  return (
    db
      .select({ h: assetVariants.blobHash })
      .from(assetVariants)
      .where(and(eq(assetVariants.assetId, p.imageAssetId), eq(assetVariants.variant, "webp_512")))
      .get()?.h ?? null
  );
}

export function toProjectSummary(
  p: ProjectRow,
  role: EffectiveRole,
  visibility: "full" | "reduced",
  songCount: number,
  imageHash: string | null = null,
): ProjectSummary {
  const color = PaletteColorSchema.safeParse(p.color);
  return {
    id: p.id,
    name: p.name,
    color: color.success ? color.data : "violet",
    imageHash,
    songCount,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    archivedAt: p.archivedAt,
    visibility,
    access: accessOf(role),
  };
}

export function toProject(
  db: Db,
  p: ProjectRow,
  role: EffectiveRole,
  visibility: "full" | "reduced",
  songCount: number,
): Project {
  const owner = db
    .select({ name: users.displayName })
    .from(users)
    .where(eq(users.id, p.ownerId))
    .get();
  return {
    ...toProjectSummary(p, role, visibility, songCount, projectImageHash(db, p)),
    description: p.description,
    downloadPolicy: p.downloadPolicy,
    ownerId: p.ownerId,
    ownerDisplayName: owner?.name ?? null,
  };
}

/** Creates a project; the creator becomes owner with an explicit manager grant (SPEC §3.3). */
export function createProjectRow(
  db: Db,
  input: { name: string; description?: string; color?: string; createdBy: string },
  now: number = Date.now(),
): ProjectRow {
  return db.transaction((tx) => {
    const project = tx
      .insert(projects)
      .values({
        id: uuidv7(now),
        name: input.name,
        description: input.description ?? "",
        color: input.color ?? "violet",
        ownerId: input.createdBy,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    tx.insert(projectGrants)
      .values({
        projectId: project.id,
        userId: input.createdBy,
        role: "manager",
        grantedBy: input.createdBy,
        grantedAt: now,
      })
      .run();
    return project;
  });
}

export interface ProjectPatch {
  name?: string;
  description?: string;
  color?: string;
  downloadPolicy?: DownloadPolicy;
  archivedAt?: number | null;
  ownerId?: string;
  imageAssetId?: string | null;
}

export function updateProjectRow(
  db: Db,
  id: string,
  patch: ProjectPatch,
  now: number = Date.now(),
): ProjectRow {
  return db
    .update(projects)
    .set({ ...patch, updatedAt: now })
    .where(eq(projects.id, id))
    .returning()
    .get();
}

/** Moves a project to the Trash (SPEC §26.3): admins restore it from Admin → Trash. */
export function softDeleteProject(
  db: Db,
  id: string,
  now: number = Date.now(),
  deletedBy: string | null = null,
): void {
  db.update(projects)
    .set({ deletedAt: now, deletedBy, updatedAt: now })
    .where(eq(projects.id, id))
    .run();
}

export function touchProject(db: Db, id: string, now: number = Date.now()): void {
  db.update(projects).set({ updatedAt: now }).where(eq(projects.id, id)).run();
}
