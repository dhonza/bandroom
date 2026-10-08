import fs from "node:fs/promises";
import { BWF_FILE } from "@bandroom/fixtures";
import { listEvents, revokeApiKey, updateUser } from "@bandroom/server-core";
import {
  API_PREFIX,
  ApiErrorSchema,
  adminListUsers,
  createProject,
  getMyUsage,
  listMySessions,
  listProjects,
  UploadResultSchema,
} from "@bandroom/shared";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { callWithKey, keyFor, seedUser, tusUpload } from "../testing/testApp";
import { admin, memberId, setupUploadFixtures, songId, t } from "../testing/uploadFixtures";

setupUploadFixtures();

const codeOf = (res: LightMyRequestResponse) =>
  res.statusCode >= 400 ? ApiErrorSchema.parse(res.json()).code : "ok";

describe("API key authentication (SPEC §29.3)", () => {
  it("reads with a read key and refuses its mutations", async () => {
    const token = keyFor(t, memberId, ["read"]);
    expect(codeOf(await callWithKey(t, listProjects, {}, token))).toBe("ok");
    const res = await callWithKey(t, createProject, { body: { name: "X" } }, token);
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe("API_KEY_SCOPE");
  });

  it("needs no CSRF header with a key, while cookies still do", async () => {
    const token = keyFor(t, memberId, ["read", "write"]);
    const res = await callWithKey(t, createProject, { body: { name: "By key" } }, token);
    expect(res.statusCode).toBe(200);
    const [event] = listEvents(t.db, { action: "project.created" }).slice(-1);
    expect(event?.apiKeyId).not.toBeNull();
    expect(event?.actorUserId).toBe(memberId);

    const cookieOnly = await t.app.inject({
      method: "POST",
      url: `${t.basePath}${API_PREFIX}/projects`,
      headers: { cookie: admin },
      payload: { name: "No CSRF" },
    });
    expect(codeOf(cookieOnly)).toBe("CSRF_HEADER_MISSING");
  });

  it("refuses unknown, revoked and expired keys and disabled users with 401", async () => {
    const bad = await callWithKey(t, listProjects, {}, "brk_unknown");
    expect(bad.statusCode).toBe(401);
    expect(codeOf(bad)).toBe("API_KEY_INVALID");

    const user = await seedUser(t, "temp", "member");
    const token = keyFor(t, user.id, ["read"]);
    expect(codeOf(await callWithKey(t, listProjects, {}, token))).toBe("ok");
    updateUser(t.db, user.id, { disabledAt: Date.now() });
    expect(codeOf(await callWithKey(t, listProjects, {}, token))).toBe("API_KEY_INVALID");

    const revoked = keyFor(t, memberId, ["read"]);
    const row = t.db.$client
      .prepare("SELECT id FROM api_keys ORDER BY created_at DESC, id DESC LIMIT 1")
      .get() as { id: string };
    revokeApiKey(t.db, row.id);
    expect(codeOf(await callWithKey(t, listProjects, {}, revoked))).toBe("API_KEY_INVALID");
  });

  it("does not fall back to the cookie when the key is bad", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `${t.basePath}${API_PREFIX}${getMyUsage.path}`,
      headers: { cookie: admin, authorization: "Bearer brk_nope" },
    });
    expect(codeOf(res)).toBe("API_KEY_INVALID");
    // Other schemes are ignored: the cookie session applies.
    const basic = await t.app.inject({
      method: "GET",
      url: `${t.basePath}${API_PREFIX}${getMyUsage.path}`,
      headers: { cookie: admin, authorization: "Basic eDp5" },
    });
    expect(basic.statusCode).toBe(200);
  });

  it("keeps admin routes for admin scopes of admins", async () => {
    const memberKey = keyFor(t, memberId, ["read", "write"]);
    expect(codeOf(await callWithKey(t, adminListUsers, {}, memberKey))).toBe("API_KEY_SCOPE");
    // Even a member key with an admin scope (not creatable through the API) gets no admin access.
    const forced = keyFor(t, memberId, ["admin:read"]);
    expect(codeOf(await callWithKey(t, adminListUsers, {}, forced))).toBe("FORBIDDEN");
    const bossId = (
      t.db.$client.prepare("SELECT id FROM users WHERE username='boss'").get() as {
        id: string;
      }
    ).id;
    const adminKey = keyFor(t, bossId, ["admin:read"]);
    expect(codeOf(await callWithKey(t, adminListUsers, {}, adminKey))).toBe("ok");
    expect(codeOf(await callWithKey(t, listProjects, {}, adminKey))).toBe("API_KEY_SCOPE");
  });

  it("refuses excluded routes and the event stream", async () => {
    const token = keyFor(t, memberId, ["read", "write"]);
    expect(codeOf(await callWithKey(t, listMySessions, {}, token))).toBe("API_KEY_SCOPE");
    const sse = await t.app.inject({
      method: "GET",
      url: `${t.basePath}${API_PREFIX}/stream`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(codeOf(sse)).toBe("API_KEY_SCOPE");
  });

  it("uploads through tus with a write key, not with a read key", async () => {
    const data = await fs.readFile(BWF_FILE());
    const target = { type: "newTrack", songId, name: "Key track" };
    const readKey = keyFor(t, memberId, ["read"]);
    const refused = await tusUpload(t, "", data, "a.wav", target, {
      authorization: `Bearer ${readKey}`,
    });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ code: "API_KEY_SCOPE" });

    const writeKey = keyFor(t, memberId, ["write"]);
    const ok = await tusUpload(t, "", data, "a.wav", target, {
      authorization: `Bearer ${writeKey}`,
    });
    expect(ok.status).toBe(200);
    const result = UploadResultSchema.parse(JSON.parse(ok.body));
    const [event] = listEvents(t.db, {
      action: "version.uploaded",
      targetId: result.trackVersionId ?? "",
    });
    expect(event?.apiKeyId).not.toBeNull();
    expect(event?.actorUserId).toBe(memberId);
  });
});
