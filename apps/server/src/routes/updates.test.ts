import fs from "node:fs";
import path from "node:path";
import { listEvents } from "@bandroom/server-core";
import {
  ApiErrorSchema,
  cancelAdminUpdate,
  getAdminUpdates,
  requestAdminUpdate,
  type UpdatesState,
} from "@bandroom/shared";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  call,
  callWithKey,
  createTestApp,
  keyFor,
  loginAs,
  seedUser,
  type TestApp,
} from "../testing/testApp";
import { compareTagsDesc, fetchReleaseTags } from "./updates";

let t: TestApp;
let admin: string;
let adminId: string;
let fetches = 0;
let fail = false;

const fakeFetch: typeof fetch = (input, init) => {
  fetches++;
  const url = String(input instanceof Request ? input.url : input);
  if (fail) return Promise.resolve(new Response("down", { status: 503 }));
  if (url.includes("/token?")) {
    expect(url).toContain(encodeURIComponent("repository:dhonza/bandroom:pull"));
    return Promise.resolve(Response.json({ token: "anon" }));
  }
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer anon");
  return Promise.resolve(
    Response.json({ tags: ["latest", "v0.4.1", "v0.10.0", "v0.4.0", "sha-abc", "v0.5.0"] }),
  );
};

const codeOf = (res: LightMyRequestResponse) =>
  res.statusCode >= 400 ? ApiErrorSchema.parse(res.json()).code : "ok";
const opsDir = () => path.join(t.dataDir, "ops");

beforeAll(async () => {
  t = await createTestApp(
    {},
    { updates: { fetch: fakeFetch, registryUrl: "https://registry.test" } },
  );
  adminId = (await seedUser(t, "boss", "admin")).id;
  await seedUser(t, "petr", "member");
  admin = await loginAs(t, "boss");
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  fs.rmSync(opsDir(), { recursive: true, force: true });
  fail = false;
});

const state = async (check = false) =>
  (await call(t, getAdminUpdates, { query: { check: String(check) } }, admin)).json<UpdatesState>();

describe("update check (SPEC §29.8)", () => {
  it("sorts release tags numerically and drops others", () => {
    expect(["v0.4.1", "v0.10.0", "v1.0.0", "v0.4.10"].sort(compareTagsDesc)).toEqual([
      "v1.0.0",
      "v0.10.0",
      "v0.4.10",
      "v0.4.1",
    ]);
    expect(compareTagsDesc("v1.2.3", "v1.2.3")).toBe(0);
  });

  it("fetches nothing until asked, then caches", async () => {
    expect((await state()).available).toBeNull();
    expect(fetches).toBe(0);
    const checked = await state(true);
    expect(checked.available).toEqual(["v0.10.0", "v0.5.0", "v0.4.1", "v0.4.0"]);
    expect(checked.imageRepo).toBe("dhonza/bandroom");
    const n = fetches;
    await state(true);
    expect(fetches).toBe(n);
  });

  it("reports a failing registry", async () => {
    fail = true;
    await expect(fetchReleaseTags("a/b", { fetch: fakeFetch })).rejects.toThrow(/503/);
  });
});

describe("update requests", () => {
  it("writes the request file once and refuses duplicates", async () => {
    const res = await call(
      t,
      requestAdminUpdate,
      { body: { action: "deploy", tag: "v0.5.0" } },
      admin,
    );
    expect(res.statusCode).toBe(200);
    const file = JSON.parse(fs.readFileSync(path.join(opsDir(), "request.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(file).toMatchObject({ action: "deploy", tag: "v0.5.0", requestedBy: "boss" });
    expect(fs.readdirSync(opsDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect((await state()).request).toMatchObject({ state: "pending", tag: "v0.5.0" });
    const again = await call(
      t,
      requestAdminUpdate,
      { body: { action: "deploy", tag: "v0.5.0" } },
      admin,
    );
    expect(codeOf(again)).toBe("UPDATE_PENDING");
    expect(listEvents(t.db, { action: "ops.update_requested" })).toHaveLength(1);

    // Picked up by the watcher: running, and no longer cancellable.
    fs.renameSync(path.join(opsDir(), "request.json"), path.join(opsDir(), "running.json"));
    expect((await state()).request?.state).toBe("running");
    expect(codeOf(await call(t, cancelAdminUpdate, {}, admin))).toBe("UPDATE_PENDING");
  });

  it("refuses unknown tags and wrong rollback confirmations", async () => {
    const unknown = await call(
      t,
      requestAdminUpdate,
      { body: { action: "deploy", tag: "v9.9.9" } },
      admin,
    );
    expect(codeOf(unknown)).toBe("UPDATE_TAG_UNKNOWN");
    const bad = await call(
      t,
      requestAdminUpdate,
      { body: { action: "deploy", tag: "v1;rm" } },
      admin,
    );
    expect(codeOf(bad)).toBe("VALIDATION_FAILED");
    const mismatch = await call(
      t,
      requestAdminUpdate,
      { body: { action: "rollback", confirmRunningVersion: "v0.0.1-other" } },
      admin,
    );
    expect(codeOf(mismatch)).toBe("UPDATE_CONFIRM_MISMATCH");
    expect(fs.existsSync(path.join(opsDir(), "request.json"))).toBe(false);
  });

  it("requests a rollback with an admin:ops key and can withdraw it", async () => {
    const running = (await state()).running;
    const key = keyFor(t, adminId, ["admin:ops"]);
    const res = await callWithKey(
      t,
      requestAdminUpdate,
      { body: { action: "rollback", confirmRunningVersion: running } },
      key,
    );
    expect(res.json<{ request: { tag: null; action: string } }>().request).toMatchObject({
      action: "rollback",
      tag: null,
    });
    expect(codeOf(await callWithKey(t, cancelAdminUpdate, {}, key))).toBe("ok");
    expect(fs.existsSync(path.join(opsDir(), "request.json"))).toBe(false);
    expect(codeOf(await call(t, cancelAdminUpdate, {}, admin))).toBe("NOT_FOUND");
    expect(listEvents(t.db, { action: "ops.update_cancelled" })).toHaveLength(1);
    const readKey = keyFor(t, adminId, ["admin:read"]);
    expect(
      codeOf(
        await callWithKey(
          t,
          requestAdminUpdate,
          { body: { action: "deploy", tag: "v0.5.0" } },
          readKey,
        ),
      ),
    ).toBe("API_KEY_SCOPE");
  });

  it("shows the newest result and the host status time", async () => {
    fs.mkdirSync(opsDir(), { recursive: true });
    const result = (id: string, exitCode: number) => ({
      id,
      action: "deploy",
      tag: "v0.5.0",
      exitCode,
      startedAt: 1,
      finishedAt: 2,
      error: null,
      outputTail: "ok",
    });
    const older = path.join(opsDir(), "result-00000000-0000-7000-8000-000000000001.json");
    const newer = path.join(opsDir(), "result-00000000-0000-7000-8000-000000000002.json");
    fs.writeFileSync(older, JSON.stringify(result("a", 1)));
    fs.writeFileSync(newer, JSON.stringify(result("b", 0)));
    fs.utimesSync(older, new Date(1000), new Date(1000));
    fs.writeFileSync(path.join(opsDir(), "result-junk.json"), "{}");
    fs.writeFileSync(path.join(opsDir(), "host-status.json"), JSON.stringify({ ts: 42 }));
    const s = await state();
    expect(s.lastResult).toMatchObject({ id: "b", exitCode: 0 });
    expect(s.hostStatusAt).toBe(42);
    fs.writeFileSync(newer, "not json");
    fs.utimesSync(newer, new Date(), new Date());
    expect((await state()).lastResult).toBeNull();
  });

  it("answers a failed registry with UPDATE_CHECK_FAILED", async () => {
    fail = true;
    const t2 = await createTestApp({}, { updates: { fetch: fakeFetch } });
    try {
      await seedUser(t2, "root", "admin");
      const cookie = await loginAs(t2, "root");
      const res = await call(t2, getAdminUpdates, { query: { check: "true" } }, cookie);
      expect(codeOf(res)).toBe("UPDATE_CHECK_FAILED");
    } finally {
      await t2.close();
    }
  });
});
