import { listEvents } from "@bandroom/server-core";
import {
  ApiErrorSchema,
  adminListApiKeys,
  adminRevokeApiKey,
  createMyApiKey,
  getMyUsage,
  listMyApiKeys,
  MAX_API_KEYS_PER_USER,
  revokeMyApiKey,
} from "@bandroom/shared";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  callWithKey,
  createTestApp,
  loginAs,
  seedUser,
  type TestApp,
} from "../testing/testApp";

let t: TestApp;
let admin: string;
let member: string;
let other: string;

const codeOf = (res: LightMyRequestResponse) =>
  res.statusCode >= 400 ? ApiErrorSchema.parse(res.json()).code : "ok";

beforeAll(async () => {
  t = await createTestApp();
  await seedUser(t, "boss", "admin");
  await seedUser(t, "petr", "member");
  await seedUser(t, "eva", "member");
  admin = await loginAs(t, "boss");
  member = await loginAs(t, "petr");
  other = await loginAs(t, "eva");
});
afterAll(async () => {
  await t.close();
});

const create = (cookie: string, body: Record<string, unknown>) =>
  call(t, createMyApiKey, { body: { name: "Reaper", expiresInDays: 90, ...body } }, cookie);

describe("API key endpoints (SPEC §29.4)", () => {
  let keyId = "";
  let token = "";

  it("creates a key, shows the token once and lists it without it", async () => {
    const res = await create(member, { scopes: ["read", "write", "read"] });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      key: { id: string; prefix: string; scopes: string[] };
      token: string;
    }>();
    keyId = body.key.id;
    token = body.token;
    expect(token.startsWith(body.key.prefix)).toBe(true);
    expect(body.key.scopes).toEqual(["read", "write"]);
    const list = (await call(t, listMyApiKeys, {}, member)).json<{ keys: object[] }>();
    expect(list.keys).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(token);
    const [event] = listEvents(t.db, { action: "auth.api_key_created" });
    expect(event?.targetId).toBe(keyId);
    expect(event?.details).not.toContain(token);
    expect(codeOf(await callWithKey(t, getMyUsage, {}, token))).toBe("ok");
  });

  it("keeps admin scopes for admins", async () => {
    expect(codeOf(await create(member, { scopes: ["admin:read"] }))).toBe("FORBIDDEN");
    expect(codeOf(await create(admin, { scopes: ["admin:read", "admin:ops"] }))).toBe("ok");
  });

  it("lets keys neither manage keys nor see them", async () => {
    expect(codeOf(await callWithKey(t, listMyApiKeys, {}, token))).toBe("API_KEY_SCOPE");
    const res = await callWithKey(
      t,
      createMyApiKey,
      { body: { name: "x", scopes: ["read"], expiresInDays: null } },
      token,
    );
    expect(codeOf(res)).toBe("API_KEY_SCOPE");
  });

  it("revokes only own keys; admins revoke any", async () => {
    expect(codeOf(await call(t, revokeMyApiKey, { params: { id: keyId } }, other))).toBe(
      "NOT_FOUND",
    );
    expect(codeOf(await call(t, revokeMyApiKey, { params: { id: keyId } }, member))).toBe("ok");
    expect(codeOf(await callWithKey(t, getMyUsage, {}, token))).toBe("API_KEY_INVALID");
    expect(codeOf(await call(t, revokeMyApiKey, { params: { id: keyId } }, member))).toBe(
      "NOT_FOUND",
    );

    const second = (await create(member, { scopes: ["read"] })).json<{ key: { id: string } }>();
    const all = (await call(t, adminListApiKeys, {}, admin)).json<{
      keys: { id: string; username: string }[];
    }>();
    expect(all.keys.find((k) => k.id === second.key.id)?.username).toBe("petr");
    expect(codeOf(await call(t, adminListApiKeys, {}, member))).toBe("FORBIDDEN");
    expect(codeOf(await call(t, adminRevokeApiKey, { params: { id: second.key.id } }, admin))).toBe(
      "ok",
    );
    const events = listEvents(t.db, { action: "auth.api_key_revoked" });
    expect(events.at(-1)?.details).toContain('"byAdmin":true');
  });

  it("limits active keys per user", async () => {
    for (let i = 0; i < MAX_API_KEYS_PER_USER; i++) {
      expect(codeOf(await create(other, { scopes: ["read"] }))).toBe("ok");
    }
    expect(codeOf(await create(other, { scopes: ["read"] }))).toBe("API_KEY_LIMIT");
  });
});
