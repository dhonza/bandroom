import type {
  Db,
  ProjectAccess,
  ProjectRow,
  SongAccess,
  SongRow,
  UserRow,
} from "@bandroom/server-core";
import {
  documentLocation,
  documentLocationOfVersion,
  getEditSessionRow,
  getLinkRow,
  songIsEditing,
  type EditSessionRow,
  type LinkRow,
  resolveProjectAccess,
  resolveSongAccess,
  songIdOfComment,
  songIdOfMarker,
  songIdOfTrack,
  songIdOfTrackVersion,
} from "@bandroom/server-core";
import {
  canDownload,
  effectiveDownloadPolicy,
  hasCapability,
  roleAtLeast,
  songLockRefusal,
  type Capability,
  type ContentScope,
  type EffectiveRole,
  type RouteAuth,
} from "@bandroom/shared";
import { AppError } from "./errors";

/** Project access after the check: hidden projects never reach handlers. */
export type ProjectScopeAccess = { scope: "project" } & Omit<ProjectAccess, "visibility"> & {
    visibility: "full" | "reduced";
  };
/** Song-level access; for track/trackVersion scopes, `targetId` is the track or version id. */
export type SongScopeAccess = {
  scope: "song" | "track" | "trackVersion" | "marker" | "comment";
  targetId: string;
} & SongAccess;
/** An edit session's access: its song's (SPEC §24.12), with the session row. */
export type EditSessionScopeAccess = {
  scope: "editSession";
  targetId: string;
  session: EditSessionRow;
} & SongAccess;
/**
 * Document-level access (SPEC §10, §28.4): documents belong to projects, so the project's role.
 * `targetId` is the document or document-version id.
 */
export interface DocumentScopeAccess {
  scope: "document" | "documentVersion";
  targetId: string;
  documentId: string;
  project: ProjectRow;
  role: EffectiveRole;
}
/** A public link, checked against its song (song/versions links) or its project (SPEC §3.5). */
export interface LinkScopeAccess {
  scope: "link";
  targetId: string;
  link: LinkRow;
  project: ProjectRow;
  song: SongRow | null;
  role: EffectiveRole;
}
export type ScopeAccess =
  | ProjectScopeAccess
  | SongScopeAccess
  | EditSessionScopeAccess
  | DocumentScopeAccess
  | LinkScopeAccess;

/** Whether the user may download this document's files (SPEC §3.4, §10). */
export function documentDownloadAllowed(access: {
  role: EffectiveRole;
  project: ProjectRow;
}): boolean {
  return canDownload(access.role, effectiveDownloadPolicy(null, access.project.downloadPolicy));
}

/** Whether the user may download originals/lossless files of this song (SPEC §3.4). */
export function downloadAllowed(access: SongAccess): boolean {
  return canDownload(
    access.role,
    effectiveDownloadPolicy(access.song.downloadPolicy, access.project.downloadPolicy),
  );
}

/**
 * Resolves and checks a scoped capability (SPEC §18.3). Scopes the user cannot see answer
 * NOT_FOUND so their existence does not leak; visible scopes without the capability answer
 * FORBIDDEN. Viewing a project is also allowed in "reduced" visibility. `download` additionally
 * applies the effective download policy, on every scope (the project's own on project scope).
 * `projectCapability` is also needed on the scope's project, with the project role (song grants
 * do not count), e.g. `song.create` for a bounce (SPEC §5.5).
 */
export function checkScope(
  db: Db,
  user: UserRow,
  scope: ContentScope,
  id: string,
  capability: Capability,
  projectCapability?: Capability,
): ScopeAccess {
  const access = checkOneScope(db, user, scope, id, capability);
  if (projectCapability === undefined) return access;
  const projectRole =
    access.scope === "project"
      ? access.role
      : (resolveProjectAccess(db, user, access.project.id)?.role ?? "none");
  if (!hasCapability(projectRole, projectCapability)) {
    throw new AppError("FORBIDDEN", `Missing capability ${projectCapability} on the project`);
  }
  return access;
}

function checkOneScope(
  db: Db,
  user: UserRow,
  scope: ContentScope,
  id: string,
  capability: Capability,
): ScopeAccess {
  if (scope === "project") {
    const access = resolveProjectAccess(db, user, id);
    if (!access || access.visibility === "hidden") {
      throw new AppError("NOT_FOUND", "Project not found");
    }
    if (
      (capability !== "view" && !hasCapability(access.role, capability)) ||
      (capability === "download" &&
        !documentDownloadAllowed({ role: access.role, project: access.project }))
    ) {
      throw new AppError("FORBIDDEN", `Missing capability ${capability}`);
    }
    return { scope, ...access, visibility: access.visibility };
  }

  if (scope === "document" || scope === "documentVersion") {
    return checkDocumentScope(db, user, scope, id, capability);
  }

  if (scope === "link") {
    const link = getLinkRow(db, id);
    if (!link) throw new AppError("NOT_FOUND", "Link not found");
    if (link.songId) {
      const a = checkScope(db, user, "song", link.songId, capability) as SongScopeAccess;
      return { scope, targetId: id, link, project: a.project, song: a.song, role: a.role };
    }
    const a = checkScope(db, user, "project", link.projectId, capability) as ProjectScopeAccess;
    if (a.visibility !== "full") throw new AppError("NOT_FOUND", "Link not found");
    return { scope, targetId: id, link, project: a.project, song: null, role: a.role };
  }

  if (scope === "editSession") {
    const session = getEditSessionRow(db, id);
    const access = session && checkSongAccess(db, user, session.songId, capability);
    if (!session || !access) throw new AppError("NOT_FOUND", "Not found");
    return { scope, targetId: id, session, ...access };
  }

  const songId =
    scope === "song"
      ? id
      : scope === "track"
        ? songIdOfTrack(db, id)
        : scope === "marker"
          ? songIdOfMarker(db, id)
          : scope === "comment"
            ? songIdOfComment(db, id)
            : songIdOfTrackVersion(db, id);
  const access = songId === undefined ? undefined : checkSongAccess(db, user, songId, capability);
  if (!access) throw new AppError("NOT_FOUND", "Not found");
  return { scope, targetId: id, ...access };
}

/** Song access: undefined when invisible (NOT_FOUND), FORBIDDEN without the capability. */
function checkSongAccess(
  db: Db,
  user: UserRow,
  songId: string,
  capability: Capability,
): SongAccess | undefined {
  const access = resolveSongAccess(db, user, songId);
  if (!access || !roleAtLeast(access.role, "viewer")) return undefined;
  if (
    !hasCapability(access.role, capability) ||
    (capability === "download" && !downloadAllowed(access))
  ) {
    throw new AppError("FORBIDDEN", `Missing capability ${capability}`);
  }
  return access;
}

/**
 * Documents resolve to their project and need at least `viewer` on it: users who see the project
 * only in the reduced view (song grants) do not see them (SPEC §3.3).
 */
function checkDocumentScope(
  db: Db,
  user: UserRow,
  scope: "document" | "documentVersion",
  id: string,
  capability: Capability,
): DocumentScopeAccess {
  const loc = scope === "document" ? documentLocation(db, id) : documentLocationOfVersion(db, id);
  if (!loc) throw new AppError("NOT_FOUND", "Not found");
  const a = resolveProjectAccess(db, user, loc.projectId);
  const access = a && { project: a.project, role: a.role };
  if (!access || !roleAtLeast(access.role, "viewer")) throw new AppError("NOT_FOUND", "Not found");
  if (
    !hasCapability(access.role, capability) ||
    (capability === "download" && !documentDownloadAllowed(access))
  ) {
    throw new AppError("FORBIDDEN", `Missing capability ${capability}`);
  }
  return { scope, targetId: id, documentId: loc.documentId, ...access };
}

/**
 * The song locks, checked centrally after authorization and body validation, for every role
 * (admins included); the rules live in the shared permissions module:
 * - the edit lock (SPEC §24.7): while an edit session is open or applying, every change to the
 *   song's tracks, versions, timeline and comments answers SONG_EDITING, except the session's
 *   own routes;
 * - the song lock (SPEC §25.12): a request inside a locked song that changes frozen content
 *   answers SONG_LOCKED.
 */
export function checkSongLock(
  db: Db,
  auth: RouteAuth | undefined,
  song: Pick<SongRow, "id" | "lockedAt"> | null | undefined,
  method: string,
  body: unknown,
): void {
  if (auth === undefined || !("scope" in auth) || !song) return;
  if (method === "GET" || method === "HEAD") return;
  const check = {
    method,
    capability: auth.capability,
    scope: auth.scope,
    lockFields: auth.lockFields,
    body,
  };
  const state = { locked: song.lockedAt !== null, editing: songIsEditing(db, song.id) };
  const refusal = songLockRefusal(state, check);
  if (refusal === "SONG_EDITING") throw new AppError(refusal, "Someone is editing the song");
  if (refusal === "SONG_LOCKED") throw new AppError(refusal, "The song is locked");
}

/**
 * The edit lock for writes that do not go through a scoped route (uploads to a song, batch
 * actions, the importer): SONG_EDITING while an edit session holds the song (SPEC §24.7).
 */
export function checkNotEditing(db: Db, songId: string): void {
  if (songIsEditing(db, songId)) throw new AppError("SONG_EDITING", "Someone is editing the song");
}

/** The song a resolved scope belongs to, if any (batch scopes have many: none). */
export function songOfAccess(access: ScopeAccess | { scope: "batch" } | null): SongRow | null {
  return access !== null && "song" in access ? access.song : null;
}
