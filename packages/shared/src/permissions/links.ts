import { z } from "zod";
import { canDownload, type Capability, type DownloadPolicy } from "./content";

/**
 * Public links (SPEC §3.5): what a link visitor may see and do. Visitors act with at most
 * `viewer` or `commenter` capabilities, limited to the link's scope. Every visitor gets the same
 * player with the Mixer (SPEC §27: the `mix-only`/`all-tracks` content option was removed). The server
 * resolves scopes against these rules centrally (apps/server/src/http/linkAuth.ts).
 */
export const LINK_SCOPES = ["project", "song", "versions"] as const;
export type LinkScope = (typeof LINK_SCOPES)[number];
export const LinkScopeSchema = z.enum(LINK_SCOPES);

/** `all` allows browsing the version stacks. */
export const LINK_VERSION_MODES = ["current-only", "all"] as const;
export type LinkVersionMode = (typeof LINK_VERSION_MODES)[number];
export const LinkVersionModeSchema = z.enum(LINK_VERSION_MODES);

export const LINK_STATUSES = ["active", "inactive", "expired", "revoked"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

/** The link settings that decide access (a subset of the stored link). */
export interface LinkPolicy {
  scopeType: LinkScope;
  versions: LinkVersionMode;
  /** Listed track versions (`versions` links only). */
  versionIds: readonly string[];
  allowDownload: boolean;
  allowComments: boolean;
  showComments: boolean;
}

export interface LinkLifecycle {
  active: boolean;
  revokedAt: number | null;
  expiresAt: number | null;
}

/** Revoked beats expired beats inactive: only `active` links can be opened. */
export function linkStatus(link: LinkLifecycle, now: number): LinkStatus {
  if (link.revokedAt !== null) return "revoked";
  if (link.expiresAt !== null && link.expiresAt <= now) return "expired";
  return link.active ? "active" : "inactive";
}

/** At most `commenter` (with comments allowed), else `viewer`. */
export function linkRole(link: Pick<LinkPolicy, "allowComments">): "viewer" | "commenter" {
  return link.allowComments ? "commenter" : "viewer";
}

/**
 * Capabilities of a link visitor. `download` is listed when the link allows downloads; the
 * project/song download policy still applies on top (see {@link linkCanDownload}).
 */
export function linkCapabilities(
  link: Pick<LinkPolicy, "allowComments" | "allowDownload">,
): Capability[] {
  return [
    "view",
    "stream",
    ...(link.allowComments ? (["comment"] as const) : []),
    ...(link.allowDownload ? (["download"] as const) : []),
  ];
}

export function linkHasCapability(
  link: Pick<LinkPolicy, "allowComments" | "allowDownload">,
  capability: Capability,
): boolean {
  return linkCapabilities(link).includes(capability);
}

/**
 * Downloads need the link's permission and a download policy that lets viewers download
 * (SPEC §3.4: visitors are at most viewers/commenters, both below `contributor`).
 */
export function linkCanDownload(
  link: Pick<LinkPolicy, "allowDownload">,
  policy: DownloadPolicy,
): boolean {
  return link.allowDownload && canDownload("viewer", policy);
}

/** A track version as the link rules see it. */
export interface LinkVersionFacts {
  versionId: string;
  isCurrent: boolean;
}

/** Whether a (non-deleted) version of a song covered by the link is visible to its visitors. */
export function linkShowsVersion(link: LinkPolicy, v: LinkVersionFacts): boolean {
  if (link.scopeType === "versions") return link.versionIds.includes(v.versionId);
  return link.versions === "all" || v.isCurrent;
}

/**
 * Band comments are hidden unless the link shows them; visitors always see the comments made
 * through the same link (SPEC §3.5 `showComments`).
 */
export function linkShowsComment(
  link: Pick<LinkPolicy, "showComments">,
  linkId: string,
  comment: { linkId: string | null },
): boolean {
  return link.showComments || comment.linkId === linkId;
}
