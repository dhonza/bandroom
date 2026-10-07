import http from "node:http";
import type { AddressInfo } from "node:net";
import { isBlockedAddress, schema } from "@bandroom/server-core";
import {
  API_PREFIX,
  createProject,
  ProjectSchema,
  setProjectGrant,
  type Project,
} from "@bandroom/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "../testing/testApp";

const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  Buffer.alloc(300, 1),
]);
let server: http.Server;
let port = 0;
let t: TestApp;
let strict: TestApp;
let owner: string;
let viewer: string;
let outsider: string;
let project: Project;

const img = (path: string) => `http://img.test:${String(port)}${path}`;

function fetchUrl(
  app: TestApp,
  cookie: string,
  body: unknown,
  opts: { projectId?: string; csrf?: boolean } = {},
) {
  return app.app.inject({
    method: "POST",
    url: `${app.basePath}${API_PREFIX}/projects/${opts.projectId ?? project.id}/image/fetch`,
    headers: { cookie, ...(opts.csrf !== false && { "x-requested-with": "bandroom" }) },
    payload: body as Record<string, unknown>,
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/cover.png") res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    else if (req.url === "/page") res.writeHead(200, { "content-type": "text/html" }).end("<p>");
    else if (req.url === "/huge")
      res
        .writeHead(200, { "content-type": "image/jpeg", "content-length": String(30 * 1024 ** 2) })
        .end();
    else if (req.url === "/internal") res.writeHead(302, { location: "http://192.168.1.1/" }).end();
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  t = await createTestApp(
    {},
    {
      imageFetch: {
        // Code-only test hook: the local server's address and port are let through.
        isBlocked: (ip) => ip !== "127.0.0.1" && isBlockedAddress(ip),
        resolve: (host) =>
          host === "img.test"
            ? Promise.resolve([{ address: "127.0.0.1", family: 4 }])
            : Promise.reject(new Error("ENOTFOUND")),
        allowedPorts: "any",
      },
    },
  );
  strict = await createTestApp();
  await seedUser(t, "owner", "member");
  await seedUser(t, "viewer", "member");
  await seedUser(t, "outsider", "member");
  owner = await loginAs(t, "owner");
  viewer = await loginAs(t, "viewer");
  outsider = await loginAs(t, "outsider");
  const res = await call(t, createProject, { body: { name: "Album", color: "teal" } }, owner);
  project = ProjectSchema.parse(res.json<{ project: unknown }>().project);
  const viewerId = t.db
    .select()
    .from(schema.users)
    .all()
    .find((u) => u.username === "viewer")?.id;
  await call(
    t,
    setProjectGrant,
    { params: { id: project.id, userId: viewerId ?? "" }, body: { role: "viewer" } },
    owner,
  );
});

afterAll(async () => {
  await t.close();
  await strict.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe("POST /projects/:id/image/fetch (SPEC §25.4)", () => {
  it("streams the image back without storing anything", async () => {
    const blobs = t.db.select().from(schema.blobs).all().length;
    const events = t.db.select().from(schema.events).all().length;
    const res = await fetchUrl(t, owner, { url: img("/cover.png") });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.rawPayload).toEqual(PNG);
    expect(t.db.select().from(schema.blobs).all()).toHaveLength(blobs);
    expect(t.db.select().from(schema.events).all()).toHaveLength(events);
  });

  it("answers stable codes for refused URLs", async () => {
    const codeOf = async (url: unknown) => {
      const res = await fetchUrl(t, owner, { url });
      return [res.statusCode, res.json<{ code: string; message: string }>()] as const;
    };
    expect(await codeOf("ftp://img.test/x")).toMatchObject([400, { code: "IMAGE_URL_INVALID" }]);
    expect(await codeOf("")).toMatchObject([400, { code: "IMAGE_URL_INVALID" }]);
    expect(await codeOf(42)).toMatchObject([400, { code: "IMAGE_URL_INVALID" }]);
    const [, blocked] = await codeOf("http://10.1.2.3/x.png");
    expect(blocked.code).toBe("IMAGE_URL_BLOCKED");
    expect(blocked.message).not.toContain("10.1.2.3"); // details stay in the log
    expect(await codeOf(img("/internal"))).toMatchObject([400, { code: "IMAGE_URL_BLOCKED" }]);
    expect(await codeOf(img("/page"))).toMatchObject([415, { code: "IMAGE_URL_NOT_IMAGE" }]);
    expect(await codeOf(img("/huge"))).toMatchObject([413, { code: "IMAGE_URL_TOO_LARGE" }]);
    expect(await codeOf(img("/missing"))).toMatchObject([502, { code: "IMAGE_URL_FAILED" }]);
    expect(await codeOf("http://unknown.test/x.png")).toMatchObject([
      502,
      { code: "IMAGE_URL_FAILED" },
    ]);
  });

  it("blocks loopback and closed ports with the default policy", async () => {
    await seedUser(strict, "admin", "admin");
    const cookie = await loginAs(strict, "admin");
    const res = await call(strict, createProject, { body: { name: "P", color: "teal" } }, cookie);
    const id = ProjectSchema.parse(res.json<{ project: unknown }>().project).id;
    for (const url of [
      `http://127.0.0.1:${String(port)}/cover.png`,
      "http://localhost/cover.png",
      "http://[::1]/cover.png",
      "http://169.254.169.254/latest/meta-data/",
      "https://example.com:8443/x.png",
    ]) {
      const r = await fetchUrl(strict, cookie, { url }, { projectId: id });
      expect([url, r.json<{ code: string }>().code]).toEqual([url, "IMAGE_URL_BLOCKED"]);
    }
  });

  it("needs the project settings capability and the CSRF header", async () => {
    expect((await fetchUrl(t, viewer, { url: img("/cover.png") })).statusCode).toBe(403);
    // Band members see the project (default visibility) but cannot change its settings.
    expect((await fetchUrl(t, outsider, { url: img("/cover.png") })).statusCode).toBe(403);
    const missing = await fetchUrl(t, owner, { url: img("/cover.png") }, { projectId: "nope" });
    expect(missing.statusCode).toBe(404);
    const noCsrf = await fetchUrl(t, owner, { url: img("/cover.png") }, { csrf: false });
    expect(noCsrf.json()).toMatchObject({ code: "CSRF_HEADER_MISSING" });
    const anon = await fetchUrl(t, "", { url: img("/cover.png") });
    expect(anon.statusCode).toBe(401);
  });

  it("is rate limited per user", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++)
      statuses.push((await fetchUrl(t, owner, { url: img("/cover.png") })).statusCode);
    expect(statuses).toContain(429);
  });
});
