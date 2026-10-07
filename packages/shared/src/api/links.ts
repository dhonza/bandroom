import { z } from "zod";
import {
  CreateLinkSchema,
  LinkAnalyticsSchema,
  LinkOpenResultSchema,
  LinkViewSchema,
  PublicLinkSchema,
  UpdateLinkSchema,
  VisitorNameSchema,
} from "../links";
import { OkSchema } from "./auth";
import { defineContract, type ContractDef } from "./contract";

const IdParams = z.object({ id: z.string().min(1).max(64) });
const LinksResponse = z.object({ links: z.array(PublicLinkSchema) });
const LinkResponse = z.object({ link: PublicLinkSchema });

// ——— management (editors of the scope, SPEC §3.5) —————————————————————————————————————————

/** Every link in the project the caller may manage (project links and song links). */
export const listProjectLinks = defineContract({
  method: "GET",
  path: "/projects/:id/links",
  params: IdParams,
  response: LinksResponse,
  auth: { capability: "link.manage", scope: "project" },
});

/** Creates a project-scope link (`scopeType: "project"`). */
export const createProjectLink = defineContract({
  method: "POST",
  path: "/projects/:id/links",
  params: IdParams,
  body: CreateLinkSchema,
  response: LinkResponse,
  errors: ["BAD_REQUEST"],
  auth: { capability: "link.manage", scope: "project" },
});

/** Links of one song (song links and version links). */
export const listSongLinks = defineContract({
  method: "GET",
  path: "/songs/:id/links",
  params: IdParams,
  response: LinksResponse,
  auth: { capability: "link.manage", scope: "song" },
});

/** Creates a `song` or `versions` link for the song. */
export const createSongLink = defineContract({
  method: "POST",
  path: "/songs/:id/links",
  params: IdParams,
  body: CreateLinkSchema,
  response: LinkResponse,
  errors: ["BAD_REQUEST"],
  auth: { capability: "link.manage", scope: "song" },
});

export const updateLink = defineContract({
  method: "PATCH",
  path: "/links/:id",
  params: IdParams,
  body: UpdateLinkSchema,
  response: LinkResponse,
  errors: ["BAD_REQUEST", "NOT_FOUND"],
  auth: { capability: "link.manage", scope: "link" },
});

/** Permanent; visitors are locked out immediately (reactivation is `active: true` instead). */
export const revokeLink = defineContract({
  method: "POST",
  path: "/links/:id/revoke",
  params: IdParams,
  response: LinkResponse,
  auth: { capability: "link.manage", scope: "link" },
});

/** Link analytics (SPEC §14.3): opens, visitors, plays, downloads, comments. */
export const getLinkAnalytics = defineContract({
  method: "GET",
  path: "/links/:id/analytics",
  params: IdParams,
  response: LinkAnalyticsSchema,
  auth: { capability: "link.manage", scope: "link" },
});

/** Admins see all links instance-wide (SPEC §3.5, §11.2 "links overview"). */
export const adminListLinks = defineContract({
  method: "GET",
  path: "/admin/links",
  response: LinksResponse,
  auth: { global: "admin.access" },
});

// ——— visitors: paths relative to `/l/:token` (see linkApiRoot) ——————————————————————————————

/**
 * Opens the link: starts (or continues) the visitor's link session. Password links answer
 * `state: "password"` until {@link unlockLink} succeeded in this browser. Unknown, inactive,
 * expired and revoked links all answer NOT_FOUND (no enumeration).
 */
export const openLink = defineContract({
  method: "POST",
  path: "/open",
  response: LinkOpenResultSchema,
  errors: ["NOT_FOUND", "RATE_LIMITED"],
  auth: { public: true },
});

/** Checks the password and sets the signed 12 h link-session cookie (SPEC §3.5). */
export const unlockLink = defineContract({
  method: "POST",
  path: "/unlock",
  body: z.object({ password: z.string().min(1).max(200) }),
  response: z.object({ view: LinkViewSchema }),
  errors: ["NOT_FOUND", "WRONG_PASSWORD", "RATE_LIMITED"],
  auth: { public: true },
});

/** The display name anonymous comments are posted under, remembered in the link session. */
export const setLinkVisitorName = defineContract({
  method: "PUT",
  path: "/visitor",
  body: z.object({ name: VisitorNameSchema }),
  response: OkSchema,
  errors: ["FORBIDDEN"],
  auth: { capability: "comment", scope: "link" },
});

/** Logs that playback started (link analytics; SPEC §14.2 play sessions arrive with M13). */
export const recordLinkPlay = defineContract({
  method: "POST",
  path: "/songs/:id/played",
  params: IdParams,
  body: z.object({ mode: z.enum(["listen", "rehearse"]) }),
  response: OkSchema,
  auth: { capability: "stream", scope: "song" },
});

/** Contracts that exist only below `/l/:token` (not on the logged-in API). */
export const LINK_VISITOR_CONTRACTS: readonly ContractDef[] = [
  openLink,
  unlockLink,
  setLinkVisitorName,
  recordLinkPlay,
];
