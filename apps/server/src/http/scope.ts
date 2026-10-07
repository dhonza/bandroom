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
  getLinkRow,
  getTrackRow,
  getTrackVersionRow,
  type LinkRow,
  resolveProjectAccess,
  resolveSongAccess,
  songIdOfComment,
  songIdOfMarker,
  songIdOfTrack,
  songIdOfTrackVersion,
} from "@bandroom/server-core";
import {
  blockedBySongLock,
  canDownload,
  effectiveDownloadPolicy,
  hasCapability,
  roleAtLeast,
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
/**
 * Document-level access (SPEC §10): the song's role for a song document, the project's role for
 * a project-level document. `targetId` is the document or document-version id.
 */
export interface DocumentScopeAccess {
  scope: "document" | "documentVersion";
  targetId: string;
  documentId: string;
  project: ProjectRow;
  song: SongRow | null;
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
  ProjectScopeAccess | SongScopeAccess | DocumentScopeAccess | LinkScopeAccess;

/** Whether the user may download this document's files (SPEC §3.4, §10). */
export function documentDownloadAllowed(access: {
  role: EffectiveRole;
  project: ProjectRow;
  song: SongRow | null;
}): boolean {
  return canDownload(
    access.role,
    effectiveDownloadPolicy(access.song?.downloadPolicy ?? null, access.project.downloadPolicy),
  );
}

/** Whether the user may download originals/lossless files of this song (SPEC §3.4). */
export function downloadAllowed(access: SongAccess): boolean {
  return canDownload(
    access.role,
    effectiveDownloadPolicy(access.song.downloadPolicy, access.project.downloadPolicy),
  );
}

/** Capabilities that only read; everything else changes the scope. */
const READ_CAPABILITIES: ReadonlySet<Capability> = new Set(["view", "stream", "download"]);

function isSystemTrackScope(db: Db, scope: "track" | "trackVersion", id: string): boolean {
  const trackId = scope === "track" ? id : getTrackVersionRow(db, id)?.trackId;
  return trackId !== undefined && getTrackRow(db, trackId)?.isSystem === true;
}

/**
 * Resolves and checks a scoped capability (SPEC §18.3). Scopes the user cannot see answer
 * NOT_FOUND so their existence does not leak; visible scopes without the capability answer
 * FORBIDDEN. Viewing a project is also allowed in "reduced" visibility. `download` additionally
 * applies the effective download policy, on every scope (the project's own on project scope).
 */
export function checkScope(
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
        !documentDownloadAllowed({ role: access.role, project: access.project, song: null }))
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
  const access = songId === undefined ? undefined : resolveSongAccess(db, user, songId);
  if (!access || !roleAtLeast(access.role, "viewer")) {
    throw new AppError("NOT_FOUND", "Not found");
  }
  // The hidden auto-mix track is the worker's: it can be listened to and downloaded, but no route
  // may rename, delete or add versions to it (the next mixdown would discard them anyway).
  if (
    (scope === "track" || scope === "trackVersion") &&
    !READ_CAPABILITIES.has(capability) &&
    isSystemTrackScope(db, scope, id)
  ) {
    throw new AppError("NOT_FOUND", "Not found");
  }
  if (
    !hasCapability(access.role, capability) ||
    (capability === "download" && !downloadAllowed(access))
  ) {
    throw new AppError("FORBIDDEN", `Missing capability ${capability}`);
  }
  return { scope, targetId: id, ...access };
}

/**
 * Documents resolve to their song, or to their project when project-level. Project-level
 * documents need at least `viewer` on the project itself: users who see the project only in the
 * reduced view (song grants) do not see them (SPEC §3.3).
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
  let access: { project: ProjectRow; song: SongRow | null; role: EffectiveRole } | undefined;
  if (loc.songId) {
    const a = resolveSongAccess(db, user, loc.songId);
    access = a && { project: a.project, song: a.song, role: a.role };
  } else {
    const a = resolveProjectAccess(db, user, loc.projectId);
    access = a && { project: a.project, song: null, role: a.role };
  }
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
 * The song lock (SPEC §25.12), checked centrally after authorization and body validation: a
 * request inside a locked song that changes frozen content answers SONG_LOCKED, for every role
 * (admins included). The rule itself lives in the shared permissions module.
 */
export function checkSongLock(
  auth: RouteAuth | undefined,
  song: Pick<SongRow, "lockedAt"> | null | undefined,
  method: string,
  body: unknown,
): void {
  if (auth === undefined || !("scope" in auth) || !song) return;
  const check = { method, capability: auth.capability, lockFields: auth.lockFields, body };
  if (blockedBySongLock(song.lockedAt !== null, check)) {
    throw new AppError("SONG_LOCKED", "The song is locked");
  }
}

/** The song a resolved scope belongs to, if any (batch scopes have many: none). */
export function songOfAccess(access: ScopeAccess | { scope: "batch" } | null): SongRow | null {
  return access !== null && "song" in access ? access.song : null;
}
