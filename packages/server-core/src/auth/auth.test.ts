import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/connection";
import { createTestDb } from "../testing/testDb";
import {
  createInvite,
  DAY_MS,
  findUsableInvite,
  listInvites,
  markInviteUsed,
  revokeInvite,
} from "./invites";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./password";
import {
  clearResetRequest,
  createPasswordReset,
  findUsablePasswordReset,
  markPasswordResetUsed,
  RESET_LINK_TTL_MS,
  upsertResetRequest,
} from "./passwordResets";
import {
  createSession,
  deleteSession,
  deleteUserSessions,
  listUserSessions,
  purgeExpiredSessions,
  resolveSession,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
} from "./sessions";
import { generateToken, hashToken, safeEqual } from "./tokens";
import {
  countActiveAdmins,
  findUserByLogin,
  getAdminUser,
  insertUser,
  isEmailTaken,
  isUsernameTaken,
  listUsersForAdmin,
  updateUser,
  type UserRow,
} from "./users";

let t: ReturnType<typeof createTestDb>;
let db: Db;
const meta = { ip: "127.0.0.1", userAgent: "vitest" };

function addUser(username: string, role: "admin" | "member" | "guest" = "member"): UserRow {
  return insertUser(
    db,
    { username, displayName: username, passwordHash: "x", globalRole: role },
    1000,
  );
}

beforeEach(() => {
  t = createTestDb();
  db = t.db;
});
afterEach(() => {
  t.close();
});

describe("tokens", () => {
  it("generates distinct 256-bit tokens and hashes them", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(generateToken());
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("compares secrets with safeEqual", () => {
    expect(safeEqual("secret", "secret")).toBe(true);
    expect(safeEqual("secret", "secreT")).toBe(false);
    expect(safeEqual("secret", "secret2")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("é", "e")).toBe(false);
  });
});

describe("password", () => {
  it("hashes with argon2id and verifies", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(h).toContain("m=19456,t=2,p=1");
    expect(await verifyPassword(h, "correct horse battery")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
    expect(await verifyAgainstDummy("x")).toBe(false);
  });
});

describe("users", () => {
  it("finds users by username or email, case-insensitively", () => {
    const u = addUser("jana");
    updateUser(db, u.id, { email: "jana@example.com" });
    expect(findUserByLogin(db, "JANA")?.id).toBe(u.id);
    expect(findUserByLogin(db, " Jana@Example.com ")?.id).toBe(u.id);
    expect(findUserByLogin(db, "nobody")).toBeUndefined();
  });

  it("detects taken usernames and emails (email may not equal another username)", () => {
    const a = addUser("petr");
    updateUser(db, a.id, { email: "p@x.cz" });
    expect(isUsernameTaken(db, "petr")).toBe(true);
    expect(isEmailTaken(db, "p@x.cz")).toBe(true);
    expect(isEmailTaken(db, "p@x.cz", a.id)).toBe(false);
    expect(isEmailTaken(db, "petr")).toBe(true);
    expect(isEmailTaken(db, "free@x.cz")).toBe(false);
  });

  it("counts only enabled admins", () => {
    const a = addUser("a1", "admin");
    addUser("a2", "admin");
    addUser("m", "member");
    expect(countActiveAdmins(db)).toBe(2);
    updateUser(db, a.id, { disabledAt: 5 });
    expect(countActiveAdmins(db)).toBe(1);
  });

  it("lists users with pending reset requests", () => {
    const a = addUser("b");
    addUser("a");
    upsertResetRequest(db, a.id, "1.2.3.4", 777);
    const list = listUsersForAdmin(db);
    expect(list.map((u) => u.username)).toEqual(["a", "b"]);
    expect(list[1]?.resetRequestedAt).toBe(777);
    expect(getAdminUser(db, a.id)?.resetRequestedAt).toBe(777);
    clearResetRequest(db, a.id);
    expect(getAdminUser(db, a.id)?.resetRequestedAt).toBeNull();
  });
});

describe("sessions", () => {
  it("creates and resolves sessions; the token is not stored", () => {
    const u = addUser("s");
    const { token, session } = createSession(db, u.id, meta, 10_000);
    expect(session.id).toBe(hashToken(token));
    expect(session.expiresAt).toBe(10_000 + SESSION_TTL_MS);
    expect(getAdminUser(db, u.id)?.lastSeenAt).toBe(10_000);
    expect(resolveSession(db, token, 10_001)?.user.id).toBe(u.id);
    expect(resolveSession(db, "bogus", 10_001)).toBeNull();
  });

  it("slides the expiry at most once per interval", () => {
    const u = addUser("s");
    const { token } = createSession(db, u.id, meta, 0);
    expect(resolveSession(db, token, 1000)?.session.expiresAt).toBe(SESSION_TTL_MS);
    const later = SESSION_TOUCH_INTERVAL_MS + 5;
    const r = resolveSession(db, token, later);
    expect(r?.session.expiresAt).toBe(later + SESSION_TTL_MS);
    expect(r?.user.lastSeenAt).toBe(later);
  });

  it("rejects expired sessions and disabled users", () => {
    const u = addUser("s");
    const { token } = createSession(db, u.id, meta, 0);
    expect(resolveSession(db, token, SESSION_TTL_MS)).toBeNull();
    const second = createSession(db, u.id, meta, 0);
    updateUser(db, u.id, { disabledAt: 1 });
    expect(resolveSession(db, second.token, 10)).toBeNull();
  });

  it("lists, revokes one, revokes others, and purges expired", () => {
    const u = addUser("s");
    const other = addUser("o");
    const a = createSession(db, u.id, meta, 0);
    const b = createSession(db, u.id, meta, 1);
    createSession(db, u.id, meta, 2);
    createSession(db, other.id, meta, 0);
    const list = listUserSessions(db, u.id, a.session.id, 3);
    expect(list).toHaveLength(3);
    expect(list.find((s) => s.current)?.id).toBe(a.session.id);
    expect(deleteSession(db, b.session.id, other.id)).toBe(false);
    expect(deleteSession(db, b.session.id, u.id)).toBe(true);
    expect(deleteUserSessions(db, u.id, a.session.id)).toBe(1);
    expect(listUserSessions(db, u.id, null, 3).map((s) => s.id)).toEqual([a.session.id]);
    expect(purgeExpiredSessions(db, SESSION_TTL_MS + 10)).toBe(2);
  });
});

describe("invites", () => {
  it("is usable once, until expiry or revocation", () => {
    const admin = addUser("admin", "admin");
    const { token, invite } = createInvite(
      db,
      { globalRole: "guest", note: "producer", createdBy: admin.id, expiresInDays: 7 },
      0,
    );
    expect(findUsableInvite(db, token, 1)?.id).toBe(invite.id);
    expect(findUsableInvite(db, token, 7 * DAY_MS)).toBeUndefined();
    const u = addUser("newbie", "guest");
    markInviteUsed(db, invite.id, u.id, 2);
    expect(findUsableInvite(db, token, 3)).toBeUndefined();
    const [info] = listInvites(db);
    expect(info).toMatchObject({
      usedByUsername: "newbie",
      createdByDisplayName: "admin",
      note: "producer",
    });

    const second = createInvite(
      db,
      { globalRole: "member", note: null, createdBy: admin.id, expiresInDays: 1 },
      0,
    );
    expect(revokeInvite(db, second.invite.id, 5)).toBe(true);
    expect(findUsableInvite(db, second.token, 6)).toBeUndefined();
    expect(revokeInvite(db, "missing")).toBe(false);
  });
});

describe("password resets", () => {
  it("are single-use, expire after 24 h, and supersede older links", () => {
    const u = addUser("r");
    const first = createPasswordReset(db, u.id, null, 0);
    const second = createPasswordReset(db, u.id, null, 10);
    expect(findUsablePasswordReset(db, first.token, 11)).toBeUndefined();
    expect(findUsablePasswordReset(db, second.token, 11)?.userId).toBe(u.id);
    expect(findUsablePasswordReset(db, second.token, 10 + RESET_LINK_TTL_MS)).toBeUndefined();
    markPasswordResetUsed(db, second.reset.tokenHash, 12);
    expect(findUsablePasswordReset(db, second.token, 13)).toBeUndefined();
  });
});
