import { uuidv7, type LinkScope, type LinkVersionMode } from "@bandroom/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { openSecret, sealSecret } from "../../auth/secretBox";
import type { Db } from "../../db/connection";
import { projects, publicLinks, songs, users } from "../../db/schema";
import { generateLinkToken, hashLinkToken, type LinkRow } from "./core";
import { expireLinkSessions } from "./sessions";

const TOKEN_PURPOSE = "public-link-token";

/** The URL token, for managers to copy the link again. */
export function linkTokenOf(appSecret: string, row: LinkRow): string {
  return openSecret(appSecret, TOKEN_PURPOSE, row.tokenSealed);
}

export interface NewLink {
  scopeType: LinkScope;
  projectId: string;
  songId: string | null;
  versionIds: readonly string[];
  versions: LinkVersionMode;
  passwordHash: string | null;
  expiresAt: number | null;
  allowDownload: boolean;
  allowComments: boolean;
  showComments: boolean;
  label: string;
  createdBy: string;
}

export function createLinkRow(
  db: Db,
  appSecret: string,
  input: NewLink,
  now: number = Date.now(),
): { row: LinkRow; token: string } {
  const token = generateLinkToken();
  const row = db
    .insert(publicLinks)
    .values({
      id: uuidv7(now),
      tokenHash: hashLinkToken(token),
      tokenSealed: sealSecret(appSecret, TOKEN_PURPOSE, token),
      scopeType: input.scopeType,
      projectId: input.projectId,
      songId: input.songId,
      versionIds: JSON.stringify([...new Set(input.versionIds)]),
      versions: input.versions,
      passwordHash: input.passwordHash,
      expiresAt: input.expiresAt,
      allowDownload: input.allowDownload,
      allowComments: input.allowComments,
      showComments: input.showComments,
      label: input.label,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return { row, token };
}

export function getLinkRow(db: Db, id: string): LinkRow | undefined {
  return db.select().from(publicLinks).where(eq(publicLinks.id, id)).get();
}

/** Looks a link up by its URL token (only the hash is stored). */
export function findLinkByToken(db: Db, token: string): LinkRow | undefined {
  return db
    .select()
    .from(publicLinks)
    .where(eq(publicLinks.tokenHash, hashLinkToken(token)))
    .get();
}

export type LinkPatch = Partial<
  Pick<
    LinkRow,
    | "label"
    | "versions"
    | "passwordHash"
    | "expiresAt"
    | "active"
    | "allowDownload"
    | "allowComments"
    | "showComments"
  >
>;

export function updateLinkRow(db: Db, id: string, patch: LinkPatch, now = Date.now()): LinkRow {
  return db
    .update(publicLinks)
    .set({ ...patch, updatedAt: now })
    .where(eq(publicLinks.id, id))
    .returning()
    .get();
}

export function revokeLinkRow(db: Db, id: string, now = Date.now()): LinkRow {
  const row = db
    .update(publicLinks)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(publicLinks.id, id), isNull(publicLinks.revokedAt)))
    .returning()
    .all()[0];
  expireLinkSessions(db, id, now);
  return row ?? (getLinkRow(db, id) as LinkRow);
}

/** Links of live projects/songs, newest first; filtered by project, song and/or link id. */
export function listLinkRows(
  db: Db,
  filter: { projectId?: string; songId?: string; linkId?: string } = {},
) {
  return db
    .select({ link: publicLinks, project: projects, song: songs })
    .from(publicLinks)
    .innerJoin(projects, eq(projects.id, publicLinks.projectId))
    .leftJoin(songs, eq(songs.id, publicLinks.songId))
    .where(
      and(
        isNull(projects.deletedAt),
        sql`(${publicLinks.songId} IS NULL OR ${songs.deletedAt} IS NULL)`,
        filter.projectId ? eq(publicLinks.projectId, filter.projectId) : undefined,
        filter.songId ? eq(publicLinks.songId, filter.songId) : undefined,
        filter.linkId ? eq(publicLinks.id, filter.linkId) : undefined,
      ),
    )
    .orderBy(desc(publicLinks.createdAt))
    .all();
}

export function userDisplayNames(db: Db, ids: readonly string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ id: users.id, n: users.displayName })
      .from(users)
      .where(inArray(users.id, [...new Set(ids)]))
      .all()
      .map((r) => [r.id, r.n]),
  );
}
