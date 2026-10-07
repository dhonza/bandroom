import {
  acceptInvite,
  adminCreateInvite,
  adminCreateResetLink,
  adminListUsers,
  adminRevokeInvite,
  AdminUserSchema,
  ApiErrorSchema,
  completePasswordReset,
  getInvite,
  getPasswordReset,
  getSession,
  listMySessions,
  login,
  logout,
  requestPasswordReset,
} from "@bandroom/shared";
import { updateUser } from "@bandroom/server-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  call,
  createTestApp,
  loginAs,
  seedUser,
  sessionCookieFrom,
  TEST_PASSWORD,
  type TestApp,
} from "../testing/testApp";

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const code = (res: { json: () => unknown }) => ApiErrorSchema.parse(res.json()).code;

describe("login / session / logout", () => {
  it("logs in by username or email and sets a hardened cookie", async () => {
    const u = await seedUser(t, "jana");
    updateUser(t.db, u.id, { email: "jana@example.com" });
    const res = await call(t, login, { body: { login: "Jana", password: TEST_PASSWORD } });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === "bandroom_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(cookie?.secure).toBeFalsy(); // http APP_URL in tests
    expect(await loginAs(t, "JANA@example.com")).toMatch(/^bandroom_session=/);
  });

  it("returns the session user, or null when anonymous", async () => {
    await seedUser(t, "petr");
    const cookie = await loginAs(t, "petr");
    const me = (await call(t, getSession, {}, cookie)).json<{ user: { username: string } }>();
    expect(me.user.username).toBe("petr");
    expect((await call(t, getSession)).json()).toEqual({ user: null });
  });

  it("rejects wrong passwords, unknown and disabled users identically", async () => {
    const u = await seedUser(t, "tom");
    const wrong = await call(t, login, { body: { login: "tom", password: "nope-nope-nope" } });
    const unknown = await call(t, login, { body: { login: "ghost", password: TEST_PASSWORD } });
    updateUser(t.db, u.id, { disabledAt: Date.now() });
    const disabled = await call(t, login, { body: { login: "tom", password: TEST_PASSWORD } });
    for (const res of [wrong, unknown, disabled]) {
      expect(res.statusCode).toBe(401);
      expect(code(res)).toBe("INVALID_CREDENTIALS");
      expect(sessionCookieFrom(res)).toBeUndefined();
    }
  });

  it("throttles a username after 5 failures, even with the right password", async () => {
    await seedUser(t, "eva");
    for (let i = 0; i < 5; i++) {
      await call(t, login, { body: { login: "eva", password: "wrong-password" } });
    }
    const res = await call(t, login, { body: { login: "eva", password: TEST_PASSWORD } });
    expect(res.statusCode).toBe(429);
    expect(ApiErrorSchema.parse(res.json())).toMatchObject({ code: "RATE_LIMITED" });
    expect(ApiErrorSchema.parse(res.json()).params?.retryAfterSec).toBeGreaterThan(0);
  });

  it("shares one failure budget between username and email logins", async () => {
    const u = await seedUser(t, "olga");
    updateUser(t.db, u.id, { email: "olga@example.com" });
    for (let i = 0; i < 5; i++) {
      const login_ = i % 2 === 0 ? "olga" : "OLGA@example.com";
      const res = await call(t, login, { body: { login: login_, password: "wrong-password" } });
      expect(res.statusCode).toBe(401);
    }
    for (const login_ of ["olga", "olga@example.com"]) {
      const res = await call(t, login, { body: { login: login_, password: TEST_PASSWORD } });
      expect(res.statusCode).toBe(429);
    }
  });

  it("logout revokes the session and clears the cookie", async () => {
    await seedUser(t, "ana");
    const cookie = await loginAs(t, "ana");
    const res = await call(t, logout, {}, cookie);
    expect(res.cookies.find((c) => c.name === "bandroom_session")?.value).toBe("");
    expect((await call(t, getSession, {}, cookie)).json()).toEqual({ user: null });
  });
});

describe("invites", () => {
  async function newInvite(role: "member" | "guest" = "guest") {
    await seedUser(t, "admin", "admin");
    const admin = await loginAs(t, "admin");
    const res = await call(
      t,
      adminCreateInvite,
      { body: { globalRole: role, note: "drummer" } },
      admin,
    );
    expect(res.statusCode).toBe(200);
    const { invite, link } = res.json<{ invite: { id: string }; link: { url: string } }>();
    expect(link.url).toMatch(/^http:\/\/localhost:3000\/invite\/[A-Za-z0-9_-]{43}$/);
    return { admin, inviteId: invite.id, token: link.url.split("/").pop() ?? "" };
  }

  const accept = (token: string, username = "newbie", password = "a-long-password") =>
    call(t, acceptInvite, {
      params: { token },
      body: { username, displayName: "New Bie", password, locale: "cs" },
    });

  it("accepts an invite once and logs the new user in with the invited role", async () => {
    const { token } = await newInvite("guest");
    expect((await call(t, getInvite, { params: { token } })).json()).toMatchObject({
      globalRole: "guest",
    });
    const res = await accept(token, "NewBie");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: { username: "newbie", globalRole: "guest", locale: "cs" },
    });
    const cookie = sessionCookieFrom(res);
    expect((await call(t, getSession, {}, cookie)).json()).toMatchObject({
      user: { username: "newbie" },
    });
    expect(code(await accept(token, "other"))).toBe("TOKEN_INVALID");
    expect(code(await call(t, getInvite, { params: { token } }))).toBe("TOKEN_INVALID");
  });

  it("rejects taken usernames and weak passwords without consuming the invite", async () => {
    const { token } = await newInvite();
    expect(code(await accept(token, "admin"))).toBe("USERNAME_TAKEN");
    const weak = await accept(token, "fresh", "short");
    expect(weak.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(weak.json()).fieldErrors).toEqual([
      { path: "body/password", message: "PASSWORD_TOO_SHORT" },
    ]);
    expect((await accept(token, "fresh")).statusCode).toBe(200);
  });

  it("rejects revoked and unknown invites", async () => {
    const { admin, inviteId, token } = await newInvite();
    await call(t, adminRevokeInvite, { params: { id: inviteId } }, admin);
    expect(code(await accept(token))).toBe("TOKEN_INVALID");
    expect(code(await call(t, getInvite, { params: { token: "nope" } }))).toBe("TOKEN_INVALID");
  });
});

describe("password reset (no email)", () => {
  it("records a request, admin creates a link, user resets and old sessions die", async () => {
    await seedUser(t, "admin", "admin");
    const victim = await seedUser(t, "jana");
    const oldCookie = await loginAs(t, "jana");

    for (const loginName of ["jana", "nobody"]) {
      const res = await call(t, requestPasswordReset, { body: { login: loginName } });
      expect(res.json()).toEqual({ ok: true });
    }

    const admin = await loginAs(t, "admin");
    const users = z
      .object({ users: z.array(AdminUserSchema) })
      .parse((await call(t, adminListUsers, {}, admin)).json()).users;
    expect(users.find((u) => u.id === victim.id)?.resetRequestedAt).toBeGreaterThan(0);

    const link = (await call(t, adminCreateResetLink, { params: { id: victim.id } }, admin)).json<{
      url: string;
    }>();
    expect(link.url).toMatch(/\/reset\/[A-Za-z0-9_-]{43}$/);
    const token = link.url.split("/").pop() ?? "";

    expect((await call(t, getPasswordReset, { params: { token } })).json()).toMatchObject({
      username: "jana",
    });
    const done = await call(t, completePasswordReset, {
      params: { token },
      body: { password: "brand-new-password" },
    });
    expect(done.statusCode).toBe(200);
    const newCookie = sessionCookieFrom(done);
    expect(newCookie).toBeDefined();

    expect((await call(t, getSession, {}, oldCookie)).json()).toEqual({ user: null });
    expect(
      (await call(t, listMySessions, {}, newCookie)).json<{ sessions: unknown[] }>().sessions,
    ).toHaveLength(1);
    expect(await loginAs(t, "jana", "brand-new-password")).toBeTruthy();
    expect(code(await call(t, getPasswordReset, { params: { token } }))).toBe("TOKEN_INVALID");

    const after = z
      .object({ users: z.array(AdminUserSchema) })
      .parse((await call(t, adminListUsers, {}, admin)).json()).users;
    expect(after.find((u) => u.id === victim.id)?.resetRequestedAt).toBeNull();
  });

  it("rate-limits reset requests per IP", async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await call(t, requestPasswordReset, { body: { login: `u${i}` } })).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe("cookie scope", () => {
  it("uses the base path and Secure for https sub-path deployments", async () => {
    const sub = await createTestApp({ APP_URL: "https://example.test/bandroom" });
    await seedUser(sub, "jana");
    const res = await call(sub, login, { body: { login: "jana", password: TEST_PASSWORD } });
    expect(res.cookies.find((c) => c.name === "bandroom_session")).toMatchObject({
      path: "/bandroom",
      secure: true,
    });
    await sub.close();
  });
});
