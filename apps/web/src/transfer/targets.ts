import type { ProjectSummary } from "@bandroom/shared";

/** The "new project" entry of the target picker. */
export const NEW_PROJECT = "__new__";

/**
 * Projects the selection can be copied or moved to (SPEC §26.6): fully visible, not archived,
 * where the user may add songs (`song.create` and `upload`); `exclude` drops the source project
 * (moving songs within their project does nothing).
 */
export function transferTargets(
  projects: readonly ProjectSummary[],
  exclude?: string,
): ProjectSummary[] {
  return projects.filter(
    (p) =>
      p.id !== exclude &&
      p.visibility === "full" &&
      p.archivedAt === null &&
      p.access.capabilities.includes("song.create") &&
      p.access.capabilities.includes("upload"),
  );
}

/** The request body's target: an existing project or a new one with a name. */
export function targetBody(
  target: string,
  newName: string,
): { targetProjectId: string } | { newProject: { name: string } } {
  return target === NEW_PROJECT
    ? { newProject: { name: newName.trim() } }
    : { targetProjectId: target };
}
