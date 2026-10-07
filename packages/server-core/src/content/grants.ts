import type { ContentRole, GrantRow } from "@bandroom/shared";
import { effectiveRole } from "@bandroom/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/connection";
import { projectGrants, songGrants, users } from "../db/schema";
import { defaultProjectRoles } from "./access";

function activeUsers(db: Db) {
  return db
    .select()
    .from(users)
    .where(and(isNull(users.deletedAt), isNull(users.disabledAt)))
    .orderBy(users.displayName)
    .all();
}

function grantMap(rows: { userId: string; role: ContentRole }[]): Map<string, ContentRole> {
  return new Map(rows.map((r) => [r.userId, r.role]));
}

/** Grants editor rows for a project: every active user with explicit, inherited and effective role. */
export function projectGrantRows(db: Db, projectId: string): GrantRow[] {
  const defaults = defaultProjectRoles(db);
  const grants = grantMap(
    db
      .select({ userId: projectGrants.userId, role: projectGrants.role })
      .from(projectGrants)
      .where(eq(projectGrants.projectId, projectId))
      .all(),
  );
  return activeUsers(db).map((u) => {
    const grant = grants.get(u.id) ?? null;
    return {
      userId: u.id,
      username: u.username,
      displayName: u.displayName,
      globalRole: u.globalRole,
      grant,
      inherited: effectiveRole({ user: u, defaults }),
      effective: effectiveRole({ user: u, projectGrant: grant, defaults }),
    };
  });
}

/** Grants editor rows for a song: inherited = the project-level role. */
export function songGrantRows(db: Db, projectId: string, songId: string): GrantRow[] {
  const defaults = defaultProjectRoles(db);
  const pGrants = grantMap(
    db
      .select({ userId: projectGrants.userId, role: projectGrants.role })
      .from(projectGrants)
      .where(eq(projectGrants.projectId, projectId))
      .all(),
  );
  const sGrants = grantMap(
    db
      .select({ userId: songGrants.userId, role: songGrants.role })
      .from(songGrants)
      .where(eq(songGrants.songId, songId))
      .all(),
  );
  return activeUsers(db).map((u) => {
    const grant = sGrants.get(u.id) ?? null;
    const projectGrant = pGrants.get(u.id) ?? null;
    return {
      userId: u.id,
      username: u.username,
      displayName: u.displayName,
      globalRole: u.globalRole,
      grant,
      inherited: effectiveRole({ user: u, projectGrant, defaults }),
      effective: effectiveRole({ user: u, projectGrant, songGrant: grant, defaults }),
    };
  });
}

/** Sets or replaces a grant; returns the previous role (for the event log). */
export function setProjectGrantRow(
  db: Db,
  projectId: string,
  userId: string,
  role: ContentRole,
  grantedBy: string,
  now: number = Date.now(),
): ContentRole | null {
  const before =
    db
      .select({ role: projectGrants.role })
      .from(projectGrants)
      .where(and(eq(projectGrants.projectId, projectId), eq(projectGrants.userId, userId)))
      .get()?.role ?? null;
  db.insert(projectGrants)
    .values({ projectId, userId, role, grantedBy, grantedAt: now })
    .onConflictDoUpdate({
      target: [projectGrants.projectId, projectGrants.userId],
      set: { role, grantedBy, grantedAt: now },
    })
    .run();
  return before;
}

export function removeProjectGrantRow(
  db: Db,
  projectId: string,
  userId: string,
): ContentRole | null {
  return (
    db
      .delete(projectGrants)
      .where(and(eq(projectGrants.projectId, projectId), eq(projectGrants.userId, userId)))
      .returning({ role: projectGrants.role })
      .get()?.role ?? null
  );
}

export function setSongGrantRow(
  db: Db,
  songId: string,
  userId: string,
  role: ContentRole,
  grantedBy: string,
  now: number = Date.now(),
): ContentRole | null {
  const before =
    db
      .select({ role: songGrants.role })
      .from(songGrants)
      .where(and(eq(songGrants.songId, songId), eq(songGrants.userId, userId)))
      .get()?.role ?? null;
  db.insert(songGrants)
    .values({ songId, userId, role, grantedBy, grantedAt: now })
    .onConflictDoUpdate({
      target: [songGrants.songId, songGrants.userId],
      set: { role, grantedBy, grantedAt: now },
    })
    .run();
  return before;
}

export function removeSongGrantRow(db: Db, songId: string, userId: string): ContentRole | null {
  return (
    db
      .delete(songGrants)
      .where(and(eq(songGrants.songId, songId), eq(songGrants.userId, userId)))
      .returning({ role: songGrants.role })
      .get()?.role ?? null
  );
}
