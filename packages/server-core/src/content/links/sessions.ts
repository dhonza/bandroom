import { createHmac, hkdfSync } from "node:crypto";
import { uuidv7 } from "@bandroom/shared";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { safeEqual } from "../../auth/tokens";
import type { Db } from "../../db/connection";
import { linkSessions } from "../../db/schema";
import type { LinkSessionRow } from "./core";

/** Link sessions last 12 h (SPEC §3.5), also for links without a password. */
export const LINK_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_PURPOSE = "public-link-session";
/** `lastSeenAt` is refreshed at most this often. */
const TOUCH_INTERVAL_MS = 60_000;

function cookieKey(appSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", appSecret, "bandroom.links", COOKIE_PURPOSE, 32));
}

function mac(appSecret: string, linkId: string, sessionId: string): string {
  return createHmac("sha256", cookieKey(appSecret))
    .update(`${linkId}.${sessionId}`)
    .digest("base64url");
}

/** Signed cookie value `<sessionId>.<HMAC(linkId, sessionId)>`: bound to one link. */
export function signLinkSession(appSecret: string, linkId: string, sessionId: string): string {
  return `${sessionId}.${mac(appSecret, linkId, sessionId)}`;
}

/** The session id of a valid cookie for this link (constant-time signature check), or null. */
export function verifyLinkSessionCookie(
  appSecret: string,
  linkId: string,
  value: string,
): string | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || value.length > 200) return null;
  const sessionId = value.slice(0, dot);
  if (!safeEqual(value.slice(dot + 1), mac(appSecret, linkId, sessionId))) return null;
  return sessionId;
}

export function createLinkSession(
  db: Db,
  linkId: string,
  meta: { ip: string | null; userAgent: string | null },
  now: number = Date.now(),
): LinkSessionRow {
  return db
    .insert(linkSessions)
    .values({
      id: uuidv7(now),
      linkId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + LINK_SESSION_TTL_MS,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
    })
    .returning()
    .get();
}

/**
 * Maintenance: removes expired visitor sessions that never set a name. Every cookie-less open
 * creates one, so they would otherwise pile up; named ones stay, because the link's activity view
 * shows the name next to the visitor's events.
 */
export function purgeExpiredLinkSessions(db: Db, now: number = Date.now()): number {
  return db
    .delete(linkSessions)
    .where(and(lt(linkSessions.expiresAt, now), isNull(linkSessions.anonymousName)))
    .run().changes;
}

/** A live session of this link (expired or foreign sessions resolve to undefined). */
export function liveLinkSession(
  db: Db,
  linkId: string,
  sessionId: string,
  now: number = Date.now(),
): LinkSessionRow | undefined {
  const s = db.select().from(linkSessions).where(eq(linkSessions.id, sessionId)).get();
  if (!s || s.linkId !== linkId || s.expiresAt <= now) return undefined;
  if (now - s.lastSeenAt > TOUCH_INTERVAL_MS) {
    db.update(linkSessions).set({ lastSeenAt: now }).where(eq(linkSessions.id, s.id)).run();
  }
  return s;
}

/** Ends every visitor session of a link (password change, revocation). */
export function expireLinkSessions(db: Db, linkId: string, now: number = Date.now()): void {
  db.update(linkSessions)
    .set({ expiresAt: now })
    .where(and(eq(linkSessions.linkId, linkId), sql`${linkSessions.expiresAt} > ${now}`))
    .run();
}

export function setLinkSessionName(db: Db, sessionId: string, name: string): void {
  db.update(linkSessions).set({ anonymousName: name }).where(eq(linkSessions.id, sessionId)).run();
}
