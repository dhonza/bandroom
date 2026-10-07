import { z } from "zod";
import type { GlobalRole, Principal } from "./global";

/**
 * Content roles for projects and songs (SPEC §3.2). Each role includes all capabilities of the
 * roles before it; `none` is an explicit deny.
 */
export const CONTENT_ROLES = [
  "none",
  "viewer",
  "commenter",
  "contributor",
  "editor",
  "manager",
] as const;
export type ContentRole = (typeof CONTENT_ROLES)[number];
export const ContentRoleSchema = z.enum(CONTENT_ROLES);

/** Admins bypass all project/song checks (SPEC §3.2). */
export type EffectiveRole = ContentRole | "admin";

export const CAPABILITIES = [
  "view",
  "stream",
  "download",
  "comment",
  "upload",
  "record",
  "annotate.own",
  "annotate.any",
  "edit.own",
  "edit.any",
  "delete.own",
  "delete.any",
  "tempo.edit",
  "version.setCurrent",
  "song.create",
  "link.manage",
  "grants.manage",
  "settings.manage",
  "project.delete",
  "song.delete",
  /** Delete permanently from the Trash, and empty it (SPEC §26.3). */
  "trash.purge",
  /** Remove the full-quality files of anyone's versions (SPEC §26.4). */
  "lossless.remove",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CapabilitySchema = z.enum(CAPABILITIES);

/** The lowest content role that has each capability (SPEC §3.2 table). */
const MIN_ROLE: Record<Capability, ContentRole> = {
  view: "viewer",
  stream: "viewer",
  download: "viewer", // further restricted by the download policy, see canDownload()
  comment: "commenter",
  upload: "contributor",
  record: "contributor",
  "annotate.own": "contributor",
  "edit.own": "contributor",
  "delete.own": "contributor",
  "annotate.any": "editor",
  "edit.any": "editor",
  "delete.any": "editor",
  "tempo.edit": "editor",
  "version.setCurrent": "editor",
  "song.create": "editor",
  "link.manage": "editor",
  "grants.manage": "manager",
  "settings.manage": "manager",
  "project.delete": "manager",
  "song.delete": "manager",
  "trash.purge": "manager",
  "lossless.remove": "manager",
};

export function roleRank(role: EffectiveRole): number {
  return role === "admin" ? CONTENT_ROLES.length : CONTENT_ROLES.indexOf(role);
}

export function roleAtLeast(role: EffectiveRole, min: ContentRole): boolean {
  return roleRank(role) >= roleRank(min);
}

export function hasCapability(role: EffectiveRole, capability: Capability): boolean {
  return roleAtLeast(role, MIN_ROLE[capability]);
}

export function capabilitiesOf(role: EffectiveRole): Capability[] {
  return CAPABILITIES.filter((c) => hasCapability(role, c));
}

export type DefaultProjectRoles = Record<Exclude<GlobalRole, "admin">, ContentRole>;

export const DEFAULT_PROJECT_ROLES: DefaultProjectRoles = { member: "contributor", guest: "none" };

export interface RoleInputs {
  user: Principal | null;
  /** Explicit grant on the project, if any (may be `none`). */
  projectGrant?: ContentRole | null;
  /** Explicit grant on the song, if any (may be `none`); omit for project scope. */
  songGrant?: ContentRole | null;
  defaults: DefaultProjectRoles;
}

/** Three-layer resolution: global → project → song (SPEC §3.3). */
export function effectiveRole({
  user,
  projectGrant,
  songGrant,
  defaults,
}: RoleInputs): EffectiveRole {
  if (user === null || user.disabledAt !== null) return "none";
  if (user.globalRole === "admin") return "admin";
  if (songGrant != null) return songGrant;
  if (projectGrant != null) return projectGrant;
  return defaults[user.globalRole];
}

/**
 * Whether a project appears in the user's library (SPEC §3.3): either the project role allows
 * viewing, or at least one song grant does ("reduced view" with only those songs).
 */
export function projectVisibility(
  projectRole: EffectiveRole,
  songGrants: readonly ContentRole[],
): "full" | "reduced" | "hidden" {
  if (roleAtLeast(projectRole, "viewer")) return "full";
  if (songGrants.some((g) => roleAtLeast(g, "viewer"))) return "reduced";
  return "hidden";
}

// --- Download policy (SPEC §3.4) ----------------------------------------------------------------

export const DOWNLOAD_POLICIES = ["all", "contributors", "editors"] as const;
export type DownloadPolicy = (typeof DOWNLOAD_POLICIES)[number];
export const DownloadPolicySchema = z.enum(DOWNLOAD_POLICIES);
export const SongDownloadPolicySchema = z.enum(["inherit", ...DOWNLOAD_POLICIES]);
export type SongDownloadPolicy = z.infer<typeof SongDownloadPolicySchema>;

const POLICY_MIN_ROLE: Record<DownloadPolicy, ContentRole> = {
  all: "viewer",
  contributors: "contributor",
  editors: "editor",
};

export function effectiveDownloadPolicy(
  song: SongDownloadPolicy | null,
  project: DownloadPolicy,
): DownloadPolicy {
  return song === null || song === "inherit" ? project : song;
}

/** "Download" = original/FLAC/WAV files; streaming (incl. offline cache) is always allowed. */
export function canDownload(role: EffectiveRole, policy: DownloadPolicy): boolean {
  return roleAtLeast(role, POLICY_MIN_ROLE[policy]);
}

/**
 * For actions on content with an owner (SPEC §3.2 `*.own` vs `*.any`): owners need the `.own`
 * capability, everyone else the `.any` one.
 */
export function canActOn(
  role: EffectiveRole,
  action: "edit" | "delete" | "annotate",
  isOwner: boolean,
): boolean {
  return hasCapability(role, `${action}.${isOwner ? "own" : "any"}`);
}

/**
 * Comments (SPEC §3.2, §8): commenters edit, delete and resolve their own comments, editors
 * anyone's (`annotate.any`).
 */
export function canActOnComment(role: EffectiveRole, isOwner: boolean): boolean {
  return hasCapability(role, isOwner ? "comment" : "annotate.any");
}

// --- Trash and batch actions (SPEC §26) --------------------------------------------------------

/** What the Trash holds and batch actions select (SPEC §26.1, §26.3). */
export const TRASH_KINDS = ["song", "track", "version"] as const;
export type TrashKind = (typeof TRASH_KINDS)[number];

/**
 * Moving an item to the Trash: songs need `song.delete` (managers), tracks and versions follow
 * the uploader rule (`delete.own` for the creator/uploader, else `delete.any`).
 */
export function canDeleteContent(role: EffectiveRole, kind: TrashKind, isOwner: boolean): boolean {
  return kind === "song" ? hasCapability(role, "song.delete") : canActOn(role, "delete", isOwner);
}

/** Restoring from the Trash needs the same rights as deleting (SPEC §26.6). */
export function canRestoreContent(role: EffectiveRole, kind: TrashKind, isOwner: boolean): boolean {
  return canDeleteContent(role, kind, isOwner);
}

/**
 * Deleting permanently (and emptying the Trash): `trash.purge` (managers, admins); uploaders may
 * also purge their own versions (SPEC §26.6).
 */
export function canPurgeContent(role: EffectiveRole, kind: TrashKind, isOwner: boolean): boolean {
  if (hasCapability(role, "trash.purge")) return true;
  return kind === "version" && isOwner && hasCapability(role, "delete.own");
}

/**
 * Containers the Trash holds besides songs, tracks and versions (SPEC §26.3): deleted projects
 * (Admin → Trash) and deleted documents (project and admin Trash). Batch actions other than
 * restore and purge never select them.
 */
export const TRASH_CONTAINER_KINDS = ["project", "document"] as const;
export type TrashContainerKind = (typeof TRASH_CONTAINER_KINDS)[number];
/** Every kind a Trash list shows. */
export const TRASH_LIST_KINDS = [...TRASH_KINDS, ...TRASH_CONTAINER_KINDS] as const;
export type TrashListKind = (typeof TRASH_LIST_KINDS)[number];

/**
 * Restoring a deleted project: admins only (only they see deleted projects). A document follows
 * the creator rule of its delete (`delete.own` for the creator, else `delete.any`).
 */
export function canRestoreContainer(
  role: EffectiveRole,
  kind: TrashContainerKind,
  isOwner: boolean,
): boolean {
  return kind === "project" ? role === "admin" : canActOn(role, "delete", isOwner);
}

/** Deleting permanently: a project only by admins, a document with `trash.purge` (managers). */
export function canPurgeContainer(role: EffectiveRole, kind: TrashContainerKind): boolean {
  return kind === "project" ? role === "admin" : hasCapability(role, "trash.purge");
}

/**
 * Removing the full-quality files (SPEC §26.4): `lossless.remove` (managers, admins), or the
 * uploader for their own versions (who still needs `delete.own`). For a song or track, `isOwner`
 * means the user uploaded every version in it, since the rule applies per version.
 */
export function canRemoveLossless(role: EffectiveRole, isOwner: boolean): boolean {
  if (hasCapability(role, "lossless.remove")) return true;
  return isOwner && hasCapability(role, "delete.own");
}

// --- Make multitrack, copy and move (SPEC §26.5, §26.6) ----------------------------------------

/**
 * Moving items out of their song or project: the same rights as deleting them (songs need
 * `song.delete`, tracks the uploader rule). A source song left without tracks goes to the Trash,
 * so emptying a song needs the right to delete it too.
 */
export function canMoveContent(role: EffectiveRole, kind: TrashKind, isOwner: boolean): boolean {
  return canDeleteContent(role, kind, isOwner);
}

/** Copying songs or tracks needs `edit.any` in the source (SPEC §26.6). */
export function canCopyContent(role: EffectiveRole): boolean {
  return hasCapability(role, "edit.any");
}

/**
 * Adding songs to a project by copying, moving or making a multitrack song: `upload` (SPEC
 * §26.6) and, since a song appears there, `song.create` (editors).
 */
export function canAddSongsTo(role: EffectiveRole): boolean {
  return hasCapability(role, "song.create") && hasCapability(role, "upload");
}

// --- Bounce (SPEC §5.5) ---------------------------------------------------------------------------

/** The capability a bounce needs on the source song, and the one it needs on its project. */
export const BOUNCE_SONG_CAPABILITY = "stream" satisfies Capability;
export const BOUNCE_PROJECT_CAPABILITY = "song.create" satisfies Capability;

/**
 * Bouncing a song's mix into a new song of the same project (SPEC §5.5): `stream` on the song
 * (its own role, song grants included) and `song.create` on the project (the project role).
 */
export function canBounce(songRole: EffectiveRole, projectRole: EffectiveRole): boolean {
  return (
    hasCapability(songRole, BOUNCE_SONG_CAPABILITY) &&
    hasCapability(projectRole, BOUNCE_PROJECT_CAPABILITY)
  );
}

// --- Song lock (SPEC §25.12) --------------------------------------------------------------------

/**
 * Capabilities whose changes a locked song refuses, for everyone (admins included): markers and
 * sections, comments (incl. replies, reactions, resolve, edit, delete) and the tempo map.
 * Reading (GET) stays allowed.
 */
export const LOCK_FROZEN_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "comment",
  "annotate.own",
  "annotate.any",
  "tempo.edit",
]);

/** Track fields that make up the default mix (SPEC §5.5): frozen while the song is locked. */
export const DEFAULT_MIX_FIELDS = ["defaultGainDb", "defaultPan", "defaultMuted"] as const;
/** Version fields frozen while the song is locked: the version gain (SPEC §25.6). */
export const VERSION_GAIN_FIELDS = ["gainDb"] as const;

/** What a request does, as far as the song lock is concerned. */
export interface LockCheck {
  method: string;
  capability: Capability;
  /** Body fields frozen by the lock on routes whose other fields stay editable. */
  lockFields?: readonly string[] | undefined;
  body?: unknown;
}

/**
 * Whether a song lock refuses this request (SPEC §25.12): a change with a frozen capability, or a
 * body that sets one of the route's frozen fields. Personal mixer state, uploads, other track
 * edits and documents stay allowed.
 */
export function blockedBySongLock(locked: boolean, check: LockCheck): boolean {
  if (!locked || check.method === "GET" || check.method === "HEAD") return false;
  if (LOCK_FROZEN_CAPABILITIES.has(check.capability)) return true;
  const { lockFields, body } = check;
  if (!lockFields || typeof body !== "object" || body === null) return false;
  return lockFields.some((f) => (body as Record<string, unknown>)[f] !== undefined);
}

/**
 * The client's view of the same rule: whether a control needing `capability` is disabled because
 * the song is locked (the control stays visible, with a "Song is locked" hint).
 */
export function lockedOut(locked: boolean, capability: Capability): boolean {
  return locked && LOCK_FROZEN_CAPABILITIES.has(capability);
}
