import type { GlobalRole, InviteInfo } from "@bandroom/shared";
import { uuidv7 } from "@bandroom/shared";
import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Db } from "../db/connection";
import { invites, users } from "../db/schema";
import { generateToken, hashToken } from "./tokens";

export type InviteRow = typeof invites.$inferSelect;
export const DAY_MS = 24 * 60 * 60 * 1000;

export function createInvite(
  db: Db,
  input: { globalRole: GlobalRole; note: string | null; createdBy: string; expiresInDays: number },
  now: number = Date.now(),
): { token: string; invite: InviteRow } {
  const token = generateToken();
  const invite = db
    .insert(invites)
    .values({
      id: uuidv7(now),
      tokenHash: hashToken(token),
      globalRole: input.globalRole,
      note: input.note,
      createdBy: input.createdBy,
      createdAt: now,
      expiresAt: now + input.expiresInDays * DAY_MS,
    })
    .returning()
    .get();
  return { token, invite };
}

/** A usable invite: exists, not used, not revoked, not expired. */
export function findUsableInvite(
  db: Db,
  token: string,
  now: number = Date.now(),
): InviteRow | undefined {
  const invite = db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, hashToken(token)))
    .get();
  if (!invite || invite.usedAt !== null || invite.revokedAt !== null || invite.expiresAt <= now) {
    return undefined;
  }
  return invite;
}

export function markInviteUsed(db: Db, id: string, userId: string, now: number = Date.now()): void {
  db.update(invites).set({ usedAt: now, usedBy: userId }).where(eq(invites.id, id)).run();
}

export function revokeInvite(db: Db, id: string, now: number = Date.now()): boolean {
  const row = db.select().from(invites).where(eq(invites.id, id)).get();
  if (!row) return false;
  if (row.revokedAt === null && row.usedAt === null) {
    db.update(invites).set({ revokedAt: now }).where(eq(invites.id, id)).run();
  }
  return true;
}

const creator = alias(users, "creator");
const usedBy = alias(users, "used_by_user");

export function listInvites(db: Db): InviteInfo[] {
  return db
    .select({ invite: invites, creatorName: creator.displayName, usedByUsername: usedBy.username })
    .from(invites)
    .leftJoin(creator, eq(creator.id, invites.createdBy))
    .leftJoin(usedBy, eq(usedBy.id, invites.usedBy))
    .orderBy(desc(invites.createdAt))
    .all()
    .map((r) => toInviteInfo(r.invite, r.creatorName, r.usedByUsername));
}

export function toInviteInfo(
  i: InviteRow,
  createdByDisplayName: string | null,
  usedByUsername: string | null,
): InviteInfo {
  return {
    id: i.id,
    globalRole: i.globalRole,
    note: i.note,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    usedAt: i.usedAt,
    usedByUsername,
    revokedAt: i.revokedAt,
    createdByDisplayName,
  };
}
