import type { SessionInfo } from "@bandroom/shared";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import type { Db } from "../db/connection";
import { sessions } from "../db/schema";
import { generateToken, hashToken } from "./tokens";
import type { UserRow } from "./users";
import { getUserById } from "./users";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry is refreshed at most this often, to avoid a DB write per request. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

export type SessionRow = typeof sessions.$inferSelect;

export interface SessionMeta {
  ip: string | null;
  userAgent: string | null;
}

export function createSession(
  db: Db,
  userId: string,
  meta: SessionMeta,
  now: number = Date.now(),
): { token: string; session: SessionRow } {
  const token = generateToken();
  const session = db
    .insert(sessions)
    .values({
      id: hashToken(token),
      userId,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + SESSION_TTL_MS,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
    })
    .returning()
    .get();
  db.$client.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now, userId);
  return { token, session };
}

/**
 * Resolves a cookie token to its session and user. Expired sessions and disabled/deleted users
 * resolve to null. Refreshes the sliding expiry (and the user's lastSeenAt) at most once a minute.
 */
export function resolveSession(
  db: Db,
  token: string,
  now: number = Date.now(),
): { session: SessionRow; user: UserRow } | null {
  const id = hashToken(token);
  const session = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (session === undefined) return null;
  if (session.expiresAt <= now) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }
  const user = getUserById(db, session.userId);
  if (user === undefined || user.disabledAt !== null) return null;

  if (now - session.lastUsedAt >= SESSION_TOUCH_INTERVAL_MS) {
    const touched = { lastUsedAt: now, expiresAt: now + SESSION_TTL_MS };
    db.update(sessions).set(touched).where(eq(sessions.id, id)).run();
    db.$client.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now, user.id);
    return { session: { ...session, ...touched }, user: { ...user, lastSeenAt: now } };
  }
  return { session, user };
}

/**
 * The enabled user of a live session, by session id, without refreshing it. Long-lived
 * connections (SSE) use it to notice logout, revocation and disabled accounts.
 */
export function liveSessionUser(
  db: Db,
  sessionId: string,
  now: number = Date.now(),
): UserRow | undefined {
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (session === undefined || session.expiresAt <= now) return undefined;
  const user = getUserById(db, session.userId);
  return user?.disabledAt === null ? user : undefined;
}

export function deleteSession(db: Db, id: string, userId?: string): boolean {
  const where =
    userId === undefined
      ? eq(sessions.id, id)
      : and(eq(sessions.id, id), eq(sessions.userId, userId));
  return db.delete(sessions).where(where).run().changes > 0;
}

/** Revokes all of a user's sessions, optionally keeping one (the current device). */
export function deleteUserSessions(db: Db, userId: string, exceptId?: string): number {
  const where =
    exceptId === undefined
      ? eq(sessions.userId, userId)
      : and(eq(sessions.userId, userId), ne(sessions.id, exceptId));
  return db.delete(sessions).where(where).run().changes;
}

export function listUserSessions(
  db: Db,
  userId: string,
  currentId: string | null,
  now: number = Date.now(),
): SessionInfo[] {
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.lastUsedAt))
    .all()
    .filter((s) => s.expiresAt > now)
    .map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      expiresAt: s.expiresAt,
      ip: s.ip,
      userAgent: s.userAgent,
      current: s.id === currentId,
    }));
}

/** Maintenance: removes expired sessions (daily job from M3). */
export function purgeExpiredSessions(db: Db, now: number = Date.now()): number {
  return db.delete(sessions).where(lt(sessions.expiresAt, now)).run().changes;
}
