import { listEvents } from "@bandroom/server-core";
import {
  adminCreateUser,
  adminDismissResetRequest,
  adminListInvites,
  adminListUsers,
  adminCreateInvite,
  adminRevokeInvite,
  adminUpdateUser,
  ApiErrorSchema,
  getSession,
  InviteInfoSchema,
  requestPasswordReset,
} from "@bandroom/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "../testing/testApp";

let t: TestApp;
let admin: string;
let adminId: string;
beforeEach(async () => {
  t = await createTestApp();
  adminId = (await seedUser(t, "boss", "admin")).id;
  admin = await loginAs(t, "boss");
});
afterEach(async () => {
  await t.close();
});

const code = (res: { json: () => unknown }) => ApiErrorSchema.parse(res.json()).code;

describe("admin users", () => {
  it("creates users directly and prevents duplicates", async () => {
    const body = {
      username: "Karel",
      displayName: "Karel",
      globalRole: "member",
      password: "initial-password",
    };
    const res = await call(t, adminCreateUser, { body }, admin);
    expect(res.json()).toMatchObject({
      user: { username: "karel", globalRole: "member", disabledAt: null },
    });
    expect(code(await call(t, adminCreateUser, { body }, admin))).toBe("USERNAME_TAKEN");
    expect(await loginAs(t, "karel", "initial-password")).toBeTruthy();
    const list = (await call(t, adminListUsers, {}, admin)).json<{
      users: { username: string }[];
    }>();
    expect(list.users.map((u) => u.username)).toEqual(["boss", "karel"]);
  });

  it("changes roles, disables (revoking sessions) and re-enables", async () => {
    const u = await seedUser(t, "jana");
    const jana = await loginAs(t, "jana");
    const promoted = await call(
      t,
      adminUpdateUser,
      { params: { id: u.id }, body: { globalRole: "guest" } },
      admin,
    );
    expect(promoted.json()).toMatchObject({ user: { globalRole: "guest" } });

    const disabled = await call(
      t,
      adminUpdateUser,
      { params: { id: u.id }, body: { disabled: true } },
      admin,
    );
    expect(
      disabled.json<{ user: { disabledAt: number | null } }>().user.disabledAt,
    ).toBeGreaterThan(0);
    expect((await call(t, getSession, {}, jana)).json()).toEqual({ user: null });
    await expect(loginAs(t, "jana")).rejects.toThrow();

    await call(t, adminUpdateUser, { params: { id: u.id }, body: { disabled: false } }, admin);
    expect(await loginAs(t, "jana")).toBeTruthy();
  });

  it("protects the last active admin", async () => {
    for (const body of [{ globalRole: "member" }, { disabled: true }]) {
      expect(code(await call(t, adminUpdateUser, { params: { id: adminId }, body }, admin))).toBe(
        "LAST_ADMIN",
      );
    }
    await seedUser(t, "second", "admin");
    const res = await call(
      t,
      adminUpdateUser,
      { params: { id: adminId }, body: { globalRole: "member" } },
      admin,
    );
    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for unknown users", async () => {
    const res = await call(
      t,
      adminUpdateUser,
      { params: { id: "missing" }, body: { displayName: "X" } },
      admin,
    );
    expect(res.statusCode).toBe(404);
  });

  it("dismisses reset requests", async () => {
    const u = await seedUser(t, "jana");
    await call(t, requestPasswordReset, { body: { login: "jana" } });
    await call(t, adminDismissResetRequest, { params: { id: u.id } }, admin);
    const list = (await call(t, adminListUsers, {}, admin)).json<{
      users: { id: string; resetRequestedAt: number | null }[];
    }>();
    expect(list.users.find((x) => x.id === u.id)?.resetRequestedAt).toBeNull();
    // Logged once; dismissing again changes nothing and logs nothing (review M15).
    await call(t, adminDismissResetRequest, { params: { id: u.id } }, admin);
    expect(
      listEvents(t.db, { action: "auth.reset_request_dismissed" }).filter(
        (e) => e.targetId === u.id,
      ),
    ).toHaveLength(1);
  });
});

describe("admin invites", () => {
  it("lists and revokes invites", async () => {
    const created = (
      await call(t, adminCreateInvite, { body: { globalRole: "member", expiresInDays: 3 } }, admin)
    ).json<{ invite: { id: string } }>();
    const list = z
      .object({ invites: z.array(InviteInfoSchema) })
      .parse((await call(t, adminListInvites, {}, admin)).json()).invites;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      globalRole: "member",
      createdByDisplayName: "Boss",
      revokedAt: null,
    });
    await call(t, adminRevokeInvite, { params: { id: created.invite.id } }, admin);
    const after = (await call(t, adminListInvites, {}, admin)).json<{
      invites: { revokedAt: number | null }[];
    }>();
    expect(after.invites[0]?.revokedAt).toBeGreaterThan(0);
    expect(
      (await call(t, adminRevokeInvite, { params: { id: "missing" } }, admin)).statusCode,
    ).toBe(404);
  });
});
