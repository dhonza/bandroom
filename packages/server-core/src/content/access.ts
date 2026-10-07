import {
  capabilitiesOf,
  effectiveRole,
  projectVisibility,
  roleAtLeast,
  type Access,
  type ContentRole,
  type DefaultProjectRoles,
  type EffectiveRole,
} from "@bandroom/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/connection";
import { projectGrants, projects, songGrants, songs } from "../db/schema";
import { getSetting } from "../settings/registry";
import type { UserRow } from "../auth/users";

export type ProjectRow = typeof projects.$inferSelect;
export type SongRow = typeof songs.$inferSelect;

export function defaultProjectRoles(db: Db): DefaultProjectRoles {
  return {
    member: getSetting(db, "defaultProjectRole.member"),
    guest: getSetting(db, "defaultProjectRole.guest"),
  };
}

export function accessOf(role: EffectiveRole): Access {
  return { role, capabilities: capabilitiesOf(role) };
}

export function getProjectRow(db: Db, id: string): ProjectRow | undefined {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .get();
}

export function getSongRow(db: Db, id: string): SongRow | undefined {
  const row = db
    .select({ song: songs })
    .from(songs)
    .innerJoin(projects, eq(projects.id, songs.projectId))
    .where(and(eq(songs.id, id), isNull(songs.deletedAt), isNull(projects.deletedAt)))
    .get();
  return row?.song;
}

function projectGrantOf(db: Db, userId: string, projectId: string): ContentRole | null {
  return (
    db
      .select({ role: projectGrants.role })
      .from(projectGrants)
      .where(and(eq(projectGrants.userId, userId), eq(projectGrants.projectId, projectId)))
      .get()?.role ?? null
  );
}

function songGrantOf(db: Db, userId: string, songId: string): ContentRole | null {
  return (
    db
      .select({ role: songGrants.role })
      .from(songGrants)
      .where(and(eq(songGrants.userId, userId), eq(songGrants.songId, songId)))
      .get()?.role ?? null
  );
}

/** The user's song grants within one project (for reduced visibility). */
function songGrantsInProject(db: Db, userId: string, projectId: string): Map<string, ContentRole> {
  const rows = db
    .select({ songId: songGrants.songId, role: songGrants.role })
    .from(songGrants)
    .innerJoin(songs, eq(songs.id, songGrants.songId))
    .where(
      and(eq(songGrants.userId, userId), eq(songs.projectId, projectId), isNull(songs.deletedAt)),
    )
    .all();
  return new Map(rows.map((r) => [r.songId, r.role]));
}

export interface ProjectAccess {
  project: ProjectRow;
  role: EffectiveRole;
  visibility: "full" | "reduced" | "hidden";
}

/** Resolves a user's access to a project; undefined when the project does not exist. */
export function resolveProjectAccess(
  db: Db,
  user: UserRow,
  projectId: string,
): ProjectAccess | undefined {
  const project = getProjectRow(db, projectId);
  if (!project) return undefined;
  const role = effectiveRole({
    user,
    projectGrant: projectGrantOf(db, user.id, projectId),
    defaults: defaultProjectRoles(db),
  });
  const grants = roleAtLeast(role, "viewer")
    ? []
    : [...songGrantsInProject(db, user.id, projectId).values()];
  return { project, role, visibility: projectVisibility(role, grants) };
}

export interface SongAccess {
  song: SongRow;
  project: ProjectRow;
  role: EffectiveRole;
}

export function resolveSongAccess(db: Db, user: UserRow, songId: string): SongAccess | undefined {
  const song = getSongRow(db, songId);
  const project = song && getProjectRow(db, song.projectId);
  if (!song || !project) return undefined;
  const role = effectiveRole({
    user,
    projectGrant: projectGrantOf(db, user.id, project.id),
    songGrant: songGrantOf(db, user.id, song.id),
    defaults: defaultProjectRoles(db),
  });
  return { song, project, role };
}

/**
 * The user's role on a song whatever its state (also in the Trash, SPEC §26.3); the caller has
 * checked that the project itself is live.
 */
/** The user's role on a project in any state (e.g. a project or document in the Trash). */
export function projectRoleOf(db: Db, user: UserRow, projectId: string): EffectiveRole {
  return effectiveRole({
    user,
    projectGrant: projectGrantOf(db, user.id, projectId),
    defaults: defaultProjectRoles(db),
  });
}

export function songRoleOf(db: Db, user: UserRow, song: SongRow): EffectiveRole {
  return effectiveRole({
    user,
    projectGrant: projectGrantOf(db, user.id, song.projectId),
    songGrant: songGrantOf(db, user.id, song.id),
    defaults: defaultProjectRoles(db),
  });
}

export interface VisibleProject {
  project: ProjectRow;
  role: EffectiveRole;
  visibility: "full" | "reduced";
  visibleSongCount: number;
}

/**
 * Projects in the user's library with their role and the number of songs the user can see.
 * One pass over the user's grants and all song ids: fine for a single band (SPEC §19.6 target:
 * 50 songs × 20 tracks).
 */
export function listVisibleProjects(
  db: Db,
  user: UserRow,
  opts: { archived: boolean },
): VisibleProject[] {
  const defaults = defaultProjectRoles(db);
  const pGrants = new Map(
    db
      .select({ projectId: projectGrants.projectId, role: projectGrants.role })
      .from(projectGrants)
      .where(eq(projectGrants.userId, user.id))
      .all()
      .map((g) => [g.projectId, g.role]),
  );
  const sGrants = new Map(
    db
      .select({ songId: songGrants.songId, role: songGrants.role })
      .from(songGrants)
      .where(eq(songGrants.userId, user.id))
      .all()
      .map((g) => [g.songId, g.role]),
  );
  const songsByProject = new Map<string, string[]>();
  for (const s of db
    .select({ id: songs.id, projectId: songs.projectId })
    .from(songs)
    .where(isNull(songs.deletedAt))
    .all()) {
    const list = songsByProject.get(s.projectId) ?? [];
    list.push(s.id);
    songsByProject.set(s.projectId, list);
  }

  const out: VisibleProject[] = [];
  for (const project of db.select().from(projects).where(isNull(projects.deletedAt)).all()) {
    if ((project.archivedAt !== null) !== opts.archived) continue;
    const role = effectiveRole({ user, projectGrant: pGrants.get(project.id) ?? null, defaults });
    const songIds = songsByProject.get(project.id) ?? [];
    const songRoles = songIds.map((id) =>
      effectiveRole({
        user,
        projectGrant: pGrants.get(project.id) ?? null,
        songGrant: sGrants.get(id) ?? null,
        defaults,
      }),
    );
    const visibility = projectVisibility(
      role,
      songIds.flatMap((id) => {
        const g = sGrants.get(id);
        return g ? [g] : [];
      }),
    );
    if (visibility === "hidden") continue;
    out.push({
      project,
      role,
      visibility,
      visibleSongCount: songRoles.filter((r) => roleAtLeast(r, "viewer")).length,
    });
  }
  return out.sort(
    (a, b) =>
      a.project.sortOrder - b.project.sortOrder || a.project.name.localeCompare(b.project.name),
  );
}

/** Songs of a project the user can see, in order, with their effective roles. */
export function listVisibleSongs(
  db: Db,
  user: UserRow,
  projectId: string,
): { song: SongRow; role: EffectiveRole }[] {
  const defaults = defaultProjectRoles(db);
  const projectGrant = projectGrantOf(db, user.id, projectId);
  const grants = songGrantsInProject(db, user.id, projectId);
  return db
    .select()
    .from(songs)
    .where(and(eq(songs.projectId, projectId), isNull(songs.deletedAt)))
    .orderBy(songs.sortOrder, songs.createdAt)
    .all()
    .map((song) => ({
      song,
      role: effectiveRole({ user, projectGrant, songGrant: grants.get(song.id) ?? null, defaults }),
    }))
    .filter((s) => roleAtLeast(s.role, "viewer"));
}
