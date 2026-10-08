import type {
  AdminUser,
  CurrentUser,
  DirectoryUser,
  GlobalRole,
  Instrument,
  Locale,
  Theme,
} from "@bandroom/shared";
import { uuidv7 } from "@bandroom/shared";
import { and, count, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../db/connection";
import { passwordResetRequests, userUsage, users } from "../db/schema";

export type UserRow = typeof users.$inferSelect;

export function toCurrentUser(u: UserRow): CurrentUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.displayName,
    globalRole: u.globalRole,
    locale: u.locale,
    theme: u.theme,
    instrumentTag: u.instrumentTag,
    instrument: u.instrument,
    docFontSize: u.docFontSize,
    createdAt: u.createdAt,
  };
}

export function toAdminUser(u: UserRow, resetRequestedAt: number | null, usedBytes = 0): AdminUser {
  return {
    ...toCurrentUser(u),
    disabledAt: u.disabledAt,
    lastSeenAt: u.lastSeenAt,
    resetRequestedAt,
    quotaBytes: u.quotaBytes,
    usedBytes,
  };
}

export function getUserById(db: Db, id: string): UserRow | undefined {
  return db
    .select()
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .get();
}

/** Looks up a non-deleted user by username or email (both stored lowercase). */
export function findUserByLogin(db: Db, login: string): UserRow | undefined {
  const l = login.trim().toLowerCase();
  return db
    .select()
    .from(users)
    .where(and(or(eq(users.username, l), eq(users.email, l)), isNull(users.deletedAt)))
    .get();
}

export function isUsernameTaken(db: Db, username: string): boolean {
  return (
    db.select({ id: users.id }).from(users).where(eq(users.username, username)).get() !== undefined
  );
}

/** Email must not collide with any user's email or username (both work as login names). */
export function isEmailTaken(db: Db, email: string, exceptUserId?: string): boolean {
  const row = db
    .select({ id: users.id })
    .from(users)
    .where(or(eq(users.email, email), eq(users.username, email)))
    .get();
  return row !== undefined && row.id !== exceptUserId;
}

export interface NewUser {
  username: string;
  displayName: string;
  email?: string | null;
  passwordHash: string;
  globalRole: GlobalRole;
  locale?: Locale | null;
  quotaBytes?: number | null;
  instrumentTag?: string;
}

export function insertUser(db: Db, u: NewUser, now: number = Date.now()): UserRow {
  return db
    .insert(users)
    .values({
      id: uuidv7(now),
      username: u.username,
      displayName: u.displayName,
      email: u.email ?? null,
      passwordHash: u.passwordHash,
      globalRole: u.globalRole,
      locale: u.locale ?? null,
      quotaBytes: u.quotaBytes ?? null,
      createdAt: now,
    })
    .returning()
    .get();
}

export interface UserPatch {
  displayName?: string;
  email?: string | null;
  locale?: Locale | null;
  theme?: Theme;
  globalRole?: GlobalRole;
  passwordHash?: string;
  disabledAt?: number | null;
  lastSeenAt?: number;
  quotaBytes?: number | null;
  instrumentTag?: string;
  instrument?: Instrument | null;
  docFontSize?: number;
}

export function updateUser(db: Db, id: string, patch: UserPatch): UserRow | undefined {
  if (Object.keys(patch).length === 0) return getUserById(db, id);
  return db.update(users).set(patch).where(eq(users.id, id)).returning().get();
}

/** Enabled, non-deleted admins (used to protect the last admin). */
export function countActiveAdmins(db: Db): number {
  const row = db
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.globalRole, "admin"), isNull(users.disabledAt), isNull(users.deletedAt)))
    .get();
  return row?.n ?? 0;
}

export function listUsersForAdmin(db: Db): AdminUser[] {
  return db
    .select({ user: users, requestedAt: passwordResetRequests.requestedAt, used: userUsage.bytes })
    .from(users)
    .leftJoin(passwordResetRequests, eq(passwordResetRequests.userId, users.id))
    .leftJoin(userUsage, eq(userUsage.userId, users.id))
    .where(isNull(users.deletedAt))
    .orderBy(users.username)
    .all()
    .map((r) => toAdminUser(r.user, r.requestedAt, r.used ?? 0));
}

export function getAdminUser(db: Db, id: string): AdminUser | undefined {
  const r = db
    .select({ user: users, requestedAt: passwordResetRequests.requestedAt, used: userUsage.bytes })
    .from(users)
    .leftJoin(passwordResetRequests, eq(passwordResetRequests.userId, users.id))
    .leftJoin(userUsage, eq(userUsage.userId, users.id))
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .get();
  return r && toAdminUser(r.user, r.requestedAt, r.used ?? 0);
}

/** Active users for pickers (grants, later mentions). */
export function listDirectoryUsers(db: Db): DirectoryUser[] {
  return db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      globalRole: users.globalRole,
    })
    .from(users)
    .where(and(isNull(users.deletedAt), isNull(users.disabledAt)))
    .orderBy(users.displayName)
    .all();
}
