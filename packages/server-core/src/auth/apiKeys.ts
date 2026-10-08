import {
  ApiScopeSchema,
  MAX_API_KEYS_PER_USER,
  uuidv7,
  type AdminApiKeyInfo,
  type ApiKeyInfo,
  type ApiScope,
} from "@bandroom/shared";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/connection";
import { apiKeys, users } from "../db/schema";
import { generateToken, hashToken } from "./tokens";
import { getUserById, type UserRow } from "./users";

/** Every API token starts with this, so it is recognisable in configs and secret scanners. */
export const API_KEY_TOKEN_PREFIX = "brk_";
/** Characters of the token kept (in clear) to identify a key in lists. */
export const API_KEY_PREFIX_LENGTH = 10;
/** `last_used_at` is written at most this often, like the session touch. */
export const API_KEY_TOUCH_INTERVAL_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ApiKeyRow = typeof apiKeys.$inferSelect;

const ScopesJson = z.array(ApiScopeSchema);

function scopesOf(row: Pick<ApiKeyRow, "scopes">): ApiScope[] {
  try {
    const parsed = ScopesJson.safeParse(JSON.parse(row.scopes));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function toApiKeyInfo(row: ApiKeyRow): ApiKeyInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: scopesOf(row),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    expiresAt: row.expiresAt,
  };
}

/** Looks like a key token (cheap check before hashing). */
export function isApiKeyToken(token: string): boolean {
  return token.startsWith(API_KEY_TOKEN_PREFIX) && token.length <= 128;
}

const activeFor = (userId: string, now: number) =>
  and(
    eq(apiKeys.userId, userId),
    isNull(apiKeys.revokedAt),
    or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
  );

export function countActiveApiKeys(db: Db, userId: string, now: number = Date.now()): number {
  return db.select({ id: apiKeys.id }).from(apiKeys).where(activeFor(userId, now)).all().length;
}

export class ApiKeyLimitError extends Error {
  constructor() {
    super(`At most ${MAX_API_KEYS_PER_USER} active API keys per user`);
    this.name = "ApiKeyLimitError";
  }
}

/**
 * Creates a key and returns its token (the only time it exists in clear). The caller checks that
 * the user may hold the scopes (`scopesAllowedFor`).
 */
export function createApiKey(
  db: Db,
  input: {
    userId: string;
    name: string;
    scopes: readonly ApiScope[];
    expiresInDays: number | null;
  },
  now: number = Date.now(),
): { token: string; key: ApiKeyRow } {
  return db.transaction(() => {
    if (countActiveApiKeys(db, input.userId, now) >= MAX_API_KEYS_PER_USER) {
      throw new ApiKeyLimitError();
    }
    const token = `${API_KEY_TOKEN_PREFIX}${generateToken()}`;
    const key = db
      .insert(apiKeys)
      .values({
        id: uuidv7(now),
        userId: input.userId,
        name: input.name,
        prefix: token.slice(0, API_KEY_PREFIX_LENGTH),
        tokenHash: hashToken(token),
        scopes: JSON.stringify([...new Set(input.scopes)]),
        createdAt: now,
        expiresAt: input.expiresInDays === null ? null : now + input.expiresInDays * DAY_MS,
      })
      .returning()
      .get();
    return { token, key };
  });
}

/**
 * Resolves a bearer token to its key and user. Unknown, revoked and expired keys and disabled or
 * deleted users resolve to null. `last_used_at`/`last_used_ip` are refreshed at most once a minute.
 */
export function resolveApiKey(
  db: Db,
  token: string,
  meta: { ip: string | null } = { ip: null },
  now: number = Date.now(),
): { key: ApiKeyRow; scopes: ApiScope[]; user: UserRow } | null {
  if (!isApiKeyToken(token)) return null;
  const key = db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.tokenHash, hashToken(token)))
    .get();
  if (key === undefined || key.revokedAt !== null) return null;
  if (key.expiresAt !== null && key.expiresAt <= now) return null;
  const user = getUserById(db, key.userId);
  if (user === undefined || user.disabledAt !== null) return null;
  if (key.lastUsedAt === null || now - key.lastUsedAt >= API_KEY_TOUCH_INTERVAL_MS) {
    db.update(apiKeys)
      .set({ lastUsedAt: now, lastUsedIp: meta.ip })
      .where(eq(apiKeys.id, key.id))
      .run();
    return { key: { ...key, lastUsedAt: now, lastUsedIp: meta.ip }, scopes: scopesOf(key), user };
  }
  return { key, scopes: scopesOf(key), user };
}

/** The user's keys that are not revoked (expired ones included, so they can be cleaned up). */
export function listUserApiKeys(db: Db, userId: string): ApiKeyInfo[] {
  return db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt))
    .all()
    .map(toApiKeyInfo);
}

/** Every non-revoked key with its owner (admin view). */
export function listAllApiKeys(db: Db): AdminApiKeyInfo[] {
  return db
    .select({ key: apiKeys, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(and(isNull(apiKeys.revokedAt), isNull(users.deletedAt)))
    .orderBy(desc(apiKeys.createdAt))
    .all()
    .map(({ key, user }) => ({
      ...toApiKeyInfo(key),
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      globalRole: user.globalRole,
    }));
}

export function getApiKey(db: Db, id: string): ApiKeyRow | undefined {
  return db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
}

/**
 * Revokes a key (optionally only one of `userId`'s). Returns the revoked row, or undefined when
 * there was no such active key.
 */
export function revokeApiKey(
  db: Db,
  id: string,
  opts: { userId?: string } = {},
  now: number = Date.now(),
): ApiKeyRow | undefined {
  const where = and(
    eq(apiKeys.id, id),
    isNull(apiKeys.revokedAt),
    ...(opts.userId === undefined ? [] : [eq(apiKeys.userId, opts.userId)]),
  );
  return db.update(apiKeys).set({ revokedAt: now }).where(where).returning().get();
}
