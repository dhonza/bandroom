import {
  ApiErrorSchema,
  changePassword,
  getMyUsage,
  getSession,
  listMySessions,
  revokeMyOtherSessions,
  revokeMySession,
  SessionInfoSchema,
  updateMe,
} from "@bandroom/shared";
import { findUserByLogin, getSetting, updateUser } from "@bandroom/server-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  call,
  createTestApp,
  loginAs,
  seedUser,
  TEST_PASSWORD,
  type TestApp,
} from "../testing/testApp";

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
  await seedUser(t, "jana");
  await seedUser(t, "petr");
});
afterEach(async () => {
  await t.close();
});

const sessionsOf = async (cookie: string) =>
  z
    .object({ sessions: z.array(SessionInfoSchema) })
    .parse((await call(t, listMySessions, {}, cookie)).json()).sessions;

describe("profile", () => {
  it("updates display name, email, language and theme", async () => {
    const cookie = await loginAs(t, "jana");
    const res = await call(
      t,
      updateMe,
      { body: { displayName: "Jana N.", email: "Jana@Example.com", locale: "cs", theme: "light" } },
      cookie,
    );
    expect(res.json()).toMatchObject({
      user: { displayName: "Jana N.", email: "jana@example.com", locale: "cs", theme: "light" },
    });
    const cleared = await call(t, updateMe, { body: { email: null, locale: null } }, cookie);
    expect(cleared.json()).toMatchObject({ user: { email: null, locale: null } });
  });

  it("rejects an email used by someone else (or equal to a username)", async () => {
    const petr = await loginAs(t, "petr");
    await call(t, updateMe, { body: { email: "p@x.cz" } }, petr);
    const jana = await loginAs(t, "jana");
    for (const email of ["p@x.cz", "petr@x.cz"]) {
      const res = await call(t, updateMe, { body: { email } }, jana);
      if (email === "p@x.cz") expect(ApiErrorSchema.parse(res.json()).code).toBe("EMAIL_TAKEN");
      else expect(res.statusCode).toBe(200);
    }
  });
});

describe("password change", () => {
  it("requires the current password and revokes other sessions", async () => {
    const a = await loginAs(t, "jana");
    const b = await loginAs(t, "jana");
    const wrong = await call(
      t,
      changePassword,
      { body: { currentPassword: "nope", newPassword: "another-password" } },
      a,
    );
    expect(ApiErrorSchema.parse(wrong.json()).code).toBe("WRONG_PASSWORD");
    const ok = await call(
      t,
      changePassword,
      { body: { currentPassword: TEST_PASSWORD, newPassword: "another-password" } },
      a,
    );
    expect(ok.statusCode).toBe(200);
    expect((await call(t, getSession, {}, a)).json()).toMatchObject({ user: { username: "jana" } });
    expect((await call(t, getSession, {}, b)).json()).toEqual({ user: null });
    expect(await loginAs(t, "jana", "another-password")).toBeTruthy();
  });
});

describe("sessions", () => {
  it("lists own sessions, revokes one, and revokes all others", async () => {
    const a = await loginAs(t, "jana");
    await loginAs(t, "jana");
    const c = await loginAs(t, "jana");
    const petr = await loginAs(t, "petr");

    const list = await sessionsOf(a);
    expect(list).toHaveLength(3);
    expect(list.filter((s) => s.current)).toHaveLength(1);

    const victim = list.find((s) => !s.current);
    if (!victim) throw new Error("no other session");
    expect((await call(t, revokeMySession, { params: { id: victim.id } }, petr)).statusCode).toBe(
      404,
    );
    expect((await call(t, revokeMySession, { params: { id: victim.id } }, a)).statusCode).toBe(200);
    expect(await sessionsOf(a)).toHaveLength(2);

    expect((await call(t, revokeMyOtherSessions, {}, a)).json()).toEqual({ revoked: 1 });
    expect((await call(t, getSession, {}, c)).json()).toEqual({ user: null });
    expect(await sessionsOf(a)).toHaveLength(1);
  });

  it("revoking the current session clears the cookie", async () => {
    const a = await loginAs(t, "jana");
    const [current] = await sessionsOf(a);
    const res = await call(t, revokeMySession, { params: { id: current?.id ?? "" } }, a);
    expect(res.cookies.find((x) => x.name === "bandroom_session")?.value).toBe("");
  });
});

describe("usage", () => {
  it("reports the default, a personal and an unlimited quota", async () => {
    const cookie = await loginAs(t, "jana");
    const user = findUserByLogin(t.db, "jana");
    if (!user) throw new Error("user missing");
    const quota = async () =>
      (await call(t, getMyUsage, {}, cookie)).json<{ quotaBytes: number | null }>().quotaBytes;
    expect(await quota()).toBe(getSetting(t.db, "defaultQuotaBytes"));
    updateUser(t.db, user.id, { quotaBytes: 1234 });
    expect(await quota()).toBe(1234);
    updateUser(t.db, user.id, { quotaBytes: -1 });
    expect(await quota()).toBeNull();
  });
});
