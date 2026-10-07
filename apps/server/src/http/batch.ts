import {
  ownsAllVersions,
  projectRoleOf,
  resolveContainer,
  resolveItem,
  resolveProjectAccess,
  songRoleOf,
  tracksLeftAfter,
  type Db,
  type ProjectRow,
  type ResolvedContainer,
  type ResolvedItem,
  type UserRow,
} from "@bandroom/server-core";
import {
  canAddSongsTo,
  canCopyContent,
  canDeleteContent,
  canMoveContent,
  canPurgeContainer,
  canPurgeContent,
  canRemoveLossless,
  canRestoreContainer,
  canRestoreContent,
  hasGlobalCapability,
  roleAtLeast,
  type BatchAction,
  type BatchItems,
  type EffectiveRole,
  type TrashContainerKind,
  type TrashKind,
} from "@bandroom/shared";
import { AppError } from "./errors";

/** One checked batch item with the user's role on its song. */
export type BatchItem = ResolvedItem & { role: EffectiveRole };
/** A checked deleted project or document (restore and purge only, SPEC §26.3). */
export type BatchContainer = ResolvedContainer & { role: EffectiveRole };

/** Where copied or moved items go (SPEC §26.6), already authorized. */
export type BatchTarget =
  { kind: "project"; project: ProjectRow } | { kind: "new"; name: string } | null;

/** What a batch route's handler receives (SPEC §26.2): every item, already authorized. */
export interface BatchScopeAccess {
  scope: "batch";
  action: BatchAction;
  items: BatchItem[];
  /** Deleted projects and documents (only restore and purge take them). */
  containers: BatchContainer[];
  target: BatchTarget;
}

/** A batch body: the items, and for copy/move the target (SPEC §26.6). */
export type BatchBody = BatchItems & {
  projects?: string[] | undefined;
  documents?: string[] | undefined;
  targetProjectId?: string | undefined;
  newProject?: { name: string } | undefined;
};

const RULE: Record<BatchAction, (role: EffectiveRole, kind: TrashKind, own: boolean) => boolean> = {
  delete: canDeleteContent,
  restore: canRestoreContent,
  purge: canPurgeContent,
  removeLossless: (role, _kind, own) => canRemoveLossless(role, own),
  move: canMoveContent,
  copy: (role) => canCopyContent(role),
  inspect: () => true,
};

/**
 * The target of a copy or move (SPEC §26.6): an existing project needs `song.create` and
 * `upload` there (a project the user cannot see answers NOT_FOUND with its id); a new project
 * needs `project.create`.
 */
function checkTarget(db: Db, user: UserRow, body: BatchBody): BatchTarget {
  if (body.newProject !== undefined) {
    if (!hasGlobalCapability(user, "project.create"))
      throw new AppError("FORBIDDEN", "Missing capability project.create");
    return { kind: "new", name: body.newProject.name };
  }
  if (body.targetProjectId === undefined) return null;
  const a = resolveProjectAccess(db, user, body.targetProjectId);
  if (!a || a.visibility === "hidden")
    throw new AppError("NOT_FOUND", "Project not found", idsParam([body.targetProjectId]));
  if (a.visibility !== "full" || !canAddSongsTo(a.role))
    throw new AppError("FORBIDDEN", "Cannot add songs to the target project");
  return { kind: "project", project: a.project };
}

/**
 * Moving tracks out of a song leaves it in the Trash when none are left (SPEC §26.5), which
 * needs the right to delete the song: otherwise those tracks are forbidden.
 */
function emptiedWithoutRight(db: Db, user: UserRow, items: readonly BatchItem[]): string[] {
  const songsChosen = new Set(items.filter((i) => i.kind === "song").map((i) => i.id));
  const bySong = new Map<string, BatchItem[]>();
  for (const i of items) {
    if (i.kind !== "track" || songsChosen.has(i.song.id)) continue;
    bySong.set(i.song.id, [...(bySong.get(i.song.id) ?? []), i]);
  }
  const out: string[] = [];
  for (const [songId, chosen] of bySong) {
    const first = chosen[0];
    if (
      !first ||
      tracksLeftAfter(
        db,
        songId,
        chosen.map((i) => i.id),
      ) > 0
    )
      continue;
    if (!canDeleteContent(first.role, "song", first.song.createdBy === user.id))
      out.push(...chosen.map((i) => i.id));
  }
  return out;
}

function idsParam(ids: readonly string[]): Record<string, string | number> {
  return { ids: ids.join(","), count: ids.length };
}

/**
 * Deleted projects and documents in a restore or purge (SPEC §26.3): the item must be in the
 * Trash and visible (a project's role, or a document's song or project role, at least `viewer`);
 * projects are for admins only. Other actions never take them (the schemas have no such fields).
 */
function checkContainers(
  db: Db,
  user: UserRow,
  action: BatchAction,
  body: BatchBody,
  missing: string[],
  forbidden: string[],
): BatchContainer[] {
  const wanted: [TrashContainerKind, readonly string[] | undefined][] = [
    ["project", body.projects],
    ["document", body.documents],
  ];
  const out: BatchContainer[] = [];
  for (const [kind, ids] of wanted) {
    for (const id of new Set(ids ?? [])) {
      const item = resolveContainer(db, kind, id);
      const ok = item !== undefined && item.deleted && (action === "restore" || action === "purge");
      const role =
        item && ok
          ? item.song
            ? songRoleOf(db, user, item.song)
            : projectRoleOf(db, user, item.project.id)
          : undefined;
      if (!item || role === undefined || !roleAtLeast(role, "viewer")) {
        missing.push(id);
        continue;
      }
      const allowed =
        action === "restore"
          ? canRestoreContainer(role, kind, item.ownerId === user.id)
          : canPurgeContainer(role, kind);
      if (!allowed) {
        forbidden.push(id);
        continue;
      }
      out.push({ ...item, role });
    }
  }
  return out;
}

/**
 * The central check for batch routes (SPEC §26.2), run after body validation. Every item is
 * resolved to its song and project: items the user cannot see (or in the wrong state: delete
 * needs a live item, restore and purge an item in the Trash) answer NOT_FOUND with their ids;
 * visible items the user may not change answer FORBIDDEN_ITEMS with their ids. Only when every
 * item passes does the handler run. Removing full quality applies per version (SPEC §26.4): a
 * song or track counts as the user's own only when they uploaded every version in it. Copy and
 * move also check the target project (SPEC §26.6).
 */
export function checkBatch(
  db: Db,
  user: UserRow,
  action: BatchAction,
  body: BatchBody,
): BatchScopeAccess {
  const wanted: [TrashKind, readonly string[] | undefined][] = [
    ["song", body.songs],
    ["track", body.tracks],
    ["version", body.versions],
  ];
  const missing: string[] = [];
  const forbidden: string[] = [];
  const items: BatchItem[] = [];
  const roles = new Map<string, EffectiveRole>();
  for (const [kind, ids] of wanted) {
    for (const id of new Set(ids ?? [])) {
      const item = resolveItem(db, kind, id);
      // Delete, remove-lossless, copy and move need a live item in a live song; restore and purge
      // an item in the Trash.
      const live = action !== "restore" && action !== "purge";
      const stateOk =
        item !== undefined &&
        (live
          ? !item.deleted &&
            item.song.deletedAt === null &&
            (action === "delete" || item.track?.deletedAt == null)
          : item.deleted);
      let role: EffectiveRole | undefined;
      if (item && stateOk) {
        role = roles.get(item.song.id);
        if (role === undefined) {
          role = songRoleOf(db, user, item.song);
          roles.set(item.song.id, role);
        }
      }
      if (!item || !stateOk || role === undefined || !roleAtLeast(role, "viewer")) {
        missing.push(id);
        continue;
      }
      const own =
        action === "removeLossless" && kind !== "version"
          ? ownsAllVersions(db, kind, id, user.id)
          : item.ownerId === user.id;
      if (!RULE[action](role, kind, own)) {
        forbidden.push(id);
        continue;
      }
      items.push({ ...item, role });
    }
  }
  const containers = checkContainers(db, user, action, body, missing, forbidden);
  if (missing.length > 0) throw new AppError("NOT_FOUND", "Items not found", idsParam(missing));
  if (action === "move") forbidden.push(...emptiedWithoutRight(db, user, items));
  if (forbidden.length > 0)
    throw new AppError("FORBIDDEN_ITEMS", "Not allowed for some items", idsParam(forbidden));
  return { scope: "batch", action, items, containers, target: checkTarget(db, user, body) };
}
