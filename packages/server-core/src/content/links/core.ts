import { createHash, randomBytes } from "node:crypto";
import { linkStatus, type LinkPolicy, type LinkStatus } from "@bandroom/shared";
import type { linkSessions, publicLinks } from "../../db/schema";

/** Public links (SPEC §3.5) and their anonymous visitor sessions (SPEC §4.4). */
export type LinkRow = typeof publicLinks.$inferSelect;
export type LinkSessionRow = typeof linkSessions.$inferSelect;

/** 128-bit random token, base64url (22 characters). */
export function generateLinkToken(): string {
  return randomBytes(16).toString("base64url");
}

export function hashLinkToken(token: string): string {
  return createHash("sha256").update(`link:${token}`).digest("hex");
}

export function parseVersionIds(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function linkPolicyOf(row: LinkRow): LinkPolicy {
  return {
    scopeType: row.scopeType,
    content: row.content,
    versions: row.versions,
    versionIds: parseVersionIds(row.versionIds),
    allowDownload: row.allowDownload,
    allowComments: row.allowComments,
    showComments: row.showComments,
  };
}

export function linkRowStatus(row: LinkRow, now: number = Date.now()): LinkStatus {
  return linkStatus(row, now);
}
