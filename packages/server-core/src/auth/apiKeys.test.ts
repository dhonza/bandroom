import { MAX_API_KEYS_PER_USER } from "@bandroom/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/connection";
import { createTestDb } from "../testing/testDb";
import {
  API_KEY_TOUCH_INTERVAL_MS,
  ApiKeyLimitError,
  countActiveApiKeys,
  createApiKey,
  getApiKey,
  isApiKeyToken,
  listAllApiKeys,
  listUserApiKeys,
  resolveApiKey,
  revokeApiKey,
} from "./apiKeys";
import { hashToken } from "./tokens";
import { insertUser, updateUser } from "./users";

let db: Db;
let close: () => void;
let userId: string;
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

beforeEach(() => {
  ({ db, close } = createTestDb());
  userId = insertUser(db, {
    username: "ann",
    displayName: "Ann",
    globalRole: "member",
    passwordHash: "x",
  }).id;
});
afterEach(() => {
  close();
});

const make = (over: Partial<Parameters<typeof createApiKey>[1]> = {}, now = T0) =>
  createApiKey(
    db,
    { userId, name: "Reaper", scopes: ["read", "write"], expiresInDays: 30, ...over },
    now,
  );

describe("API keys", () => {
  it("creates a key whose token is stored only as a hash", () => {
    const { token, key } = make();
    expect(token).toMatch(/^brk_[A-Za-z0-9_-]{43}$/);
    expect(key.prefix).toBe(token.slice(0, 10));
    expect(key.tokenHash).toBe(hashToken(token));
    expect(key.expiresAt).toBe(T0 + 30 * DAY);
    expect(JSON.parse(key.scopes)).toEqual(["read", "write"]);
    expect(make({ expiresInDays: null }).key.expiresAt).toBeNull();
  });

  it("resolves valid keys and touches them at most once a minute", () => {
    const { token, key } = make();
    const r = resolveApiKey(db, token, { ip: "1.2.3.4" }, T0 + 1000);
    expect(r?.user.id).toBe(userId);
    expect(r?.scopes).toEqual(["read", "write"]);
    expect(getApiKey(db, key.id)?.lastUsedIp).toBe("1.2.3.4");
    resolveApiKey(db, token, { ip: "5.6.7.8" }, T0 + 2000);
    expect(getApiKey(db, key.id)?.lastUsedAt).toBe(T0 + 1000);
    resolveApiKey(db, token, undefined, T0 + 1000 + API_KEY_TOUCH_INTERVAL_MS);
    expect(getApiKey(db, key.id)?.lastUsedAt).toBe(T0 + 1000 + API_KEY_TOUCH_INTERVAL_MS);
  });

  it("rejects unknown, malformed, expired and revoked keys and disabled users", () => {
    expect(resolveApiKey(db, "brk_nope")).toBeNull();
    expect(resolveApiKey(db, "not-a-key")).toBeNull();
    expect(isApiKeyToken(`brk_${"x".repeat(200)}`)).toBe(false);

    const expired = make();
    expect(resolveApiKey(db, expired.token, undefined, T0 + 30 * DAY)).toBeNull();

    const revoked = make();
    expect(revokeApiKey(db, revoked.key.id, {}, T0 + 1)?.revokedAt).toBe(T0 + 1);
    expect(revokeApiKey(db, revoked.key.id)).toBeUndefined();
    expect(resolveApiKey(db, revoked.token, undefined, T0 + 2)).toBeNull();

    const live = make({ expiresInDays: null });
    updateUser(db, userId, { disabledAt: T0 });
    expect(resolveApiKey(db, live.token, undefined, T0 + 3)).toBeNull();
  });

  it("ignores unparseable scopes", () => {
    const { token, key } = make();
    db.$client.prepare("UPDATE api_keys SET scopes = ? WHERE id = ?").run("nope", key.id);
    expect(resolveApiKey(db, token, undefined, T0)?.scopes).toEqual([]);
    db.$client.prepare("UPDATE api_keys SET scopes = ? WHERE id = ?").run('["root"]', key.id);
    expect(resolveApiKey(db, token, undefined, T0)?.scopes).toEqual([]);
  });

  it("revokes only the owner's key when asked to", () => {
    const { key } = make();
    expect(revokeApiKey(db, key.id, { userId: "someone-else" })).toBeUndefined();
    expect(revokeApiKey(db, key.id, { userId })?.id).toBe(key.id);
  });

  it("limits active keys per user", () => {
    for (let i = 0; i < MAX_API_KEYS_PER_USER; i++) make();
    expect(countActiveApiKeys(db, userId, T0)).toBe(MAX_API_KEYS_PER_USER);
    expect(() => make()).toThrow(ApiKeyLimitError);
    // Expired keys no longer count.
    expect(() => make({}, T0 + 31 * DAY)).not.toThrow();
  });

  it("lists non-revoked keys per user and for admins", () => {
    const a = make({ name: "A" }, T0);
    make({ name: "B" }, T0 + 1);
    revokeApiKey(db, a.key.id);
    expect(listUserApiKeys(db, userId).map((k) => k.name)).toEqual(["B"]);
    const all = listAllApiKeys(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: "B", username: "ann", globalRole: "member" });
  });
});
