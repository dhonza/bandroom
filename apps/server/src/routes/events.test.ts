import {
  acceptInvite,
  adminCreateInvite,
  adminCreateResetLink,
  adminRevokeInvite,
  adminUpdateUser,
  changePassword,
  completePasswordReset,
  login,
  logout,
  requestPasswordReset,
  revokeMyOtherSessions,
  updateMe,
} from "@bandroom/shared";
import { listEvents } from "@bandroom/server-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
afterEach(async () => {
  await t.close();
});

describe("activity log for M1 actions (SPEC §14.1)", () => {
  it("records auth, invite, reset and user-management events with actor and request data", async () => {
    const boss = await seedUser(t, "boss", "admin");
    const jana = await seedUser(t, "jana");

    await call(t, login, { body: { login: "jana", password: "wrong-password" } });
    const admin = await loginAs(t, "boss");
    const janaCookie = await loginAs(t, "jana");
    await loginAs(t, "jana");

    await call(t, updateMe, { body: { displayName: "Jana N." } }, janaCookie);
    await call(
      t,
      changePassword,
      { body: { currentPassword: TEST_PASSWORD, newPassword: "another-password" } },
      janaCookie,
    );
    await call(t, revokeMyOtherSessions, {}, janaCookie);
    await call(t, logout, {}, janaCookie);

    const inv = (await call(t, adminCreateInvite, { body: { globalRole: "guest" } }, admin)).json<{
      invite: { id: string };
      link: { url: string };
    }>();
    await call(t, acceptInvite, {
      params: { token: inv.link.url.split("/").pop() ?? "" },
      body: { username: "newbie", displayName: "N", password: "a-long-password", locale: "en" },
    });
    const inv2 = (
      await call(t, adminCreateInvite, { body: { globalRole: "member" } }, admin)
    ).json<{ invite: { id: string } }>();
    await call(t, adminRevokeInvite, { params: { id: inv2.invite.id } }, admin);

    await call(t, requestPasswordReset, { body: { login: "jana" } });
    const link = (await call(t, adminCreateResetLink, { params: { id: jana.id } }, admin)).json<{
      url: string;
    }>();
    await call(t, completePasswordReset, {
      params: { token: link.url.split("/").pop() ?? "" },
      body: { password: "reset-password-1" },
    });

    await call(
      t,
      adminUpdateUser,
      { params: { id: jana.id }, body: { globalRole: "guest", displayName: "J" } },
      admin,
    );
    await call(t, adminUpdateUser, { params: { id: jana.id }, body: { disabled: true } }, admin);
    await call(t, adminUpdateUser, { params: { id: jana.id }, body: { disabled: false } }, admin);

    const actions = listEvents(t.db).map((e) => e.action);
    expect(actions).toEqual([
      "auth.login_failed",
      "auth.login",
      "auth.login",
      "auth.login",
      "user.updated",
      "auth.password_changed",
      "auth.sessions_revoked",
      "auth.logout",
      "user.invited",
      "invite.accepted",
      "user.invited",
      "invite.revoked",
      "auth.reset_requested",
      "auth.reset_link_created",
      "auth.password_reset",
      "user.updated",
      "user.role_changed",
      "user.disabled",
      "user.enabled",
    ]);

    const failed = listEvents(t.db, { action: "auth.login_failed" })[0];
    expect(failed).toMatchObject({
      actorUserId: jana.id,
      ip: "127.0.0.1",
      details: JSON.stringify({ login: "jana" }),
    });
    const roleChange = listEvents(t.db, { action: "user.role_changed" })[0];
    expect(roleChange).toMatchObject({ actorUserId: boss.id, targetId: jana.id });
    expect(JSON.parse(roleChange?.details ?? "{}")).toEqual({ before: "member", after: "guest" });
    const firstLogin = listEvents(t.db, { action: "auth.login" })[0];
    expect(firstLogin?.sessionId).toMatch(/^[0-9a-f]{64}$/);
  });
});
