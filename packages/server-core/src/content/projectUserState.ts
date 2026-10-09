import { and, eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { projectUserState } from "../db/schema";

export interface ProjectUserState {
  starredAt: number | null;
  lastAccessedAt: number | null;
}

/** The user's star and last access per project id (Library, SPEC §11). */
export function projectUserStates(db: Db, userId: string): Map<string, ProjectUserState> {
  return new Map(
    db
      .select({
        projectId: projectUserState.projectId,
        starredAt: projectUserState.starredAt,
        lastAccessedAt: projectUserState.lastAccessedAt,
      })
      .from(projectUserState)
      .where(eq(projectUserState.userId, userId))
      .all()
      .map(({ projectId, ...state }) => [projectId, state]),
  );
}

export function projectUserStateOf(
  db: Db,
  userId: string,
  projectId: string,
): ProjectUserState | null {
  return (
    db
      .select({
        starredAt: projectUserState.starredAt,
        lastAccessedAt: projectUserState.lastAccessedAt,
      })
      .from(projectUserState)
      .where(and(eq(projectUserState.userId, userId), eq(projectUserState.projectId, projectId)))
      .get() ?? null
  );
}

/**
 * Stars or unstars the project for the user. Starring keeps the first star time; returns whether
 * anything changed (the caller writes an event only then).
 */
export function setProjectStarRow(
  db: Db,
  userId: string,
  projectId: string,
  starred: boolean,
  now: number = Date.now(),
): boolean {
  const current = projectUserStateOf(db, userId, projectId);
  if ((current?.starredAt != null) === starred) return false;
  const starredAt = starred ? now : null;
  db.insert(projectUserState)
    .values({ userId, projectId, starredAt, lastAccessedAt: null })
    .onConflictDoUpdate({
      target: [projectUserState.userId, projectUserState.projectId],
      set: { starredAt },
    })
    .run();
  return true;
}

/** Records that the user opened the project, one of its songs or its queue (a read: no event). */
export function recordProjectAccess(
  db: Db,
  userId: string,
  projectId: string,
  now: number = Date.now(),
): void {
  db.insert(projectUserState)
    .values({ userId, projectId, starredAt: null, lastAccessedAt: now })
    .onConflictDoUpdate({
      target: [projectUserState.userId, projectUserState.projectId],
      set: { lastAccessedAt: now },
    })
    .run();
}
