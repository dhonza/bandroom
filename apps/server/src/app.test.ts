import { setSetting } from "@bandroom/server-core";
import { ApiErrorSchema, ClientConfigSchema, MetaSchema } from "@bandroom/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./testing/testApp";

const HTML = { accept: "text/html,application/xhtml+xml" };

function extractClientConfig(html: string): unknown {
  const m = /<meta name="bandroom-config" content="([^"]*)">/.exec(html);
  if (!m?.[1]) throw new Error("config meta missing");
  return JSON.parse(
    m[1]
      .replaceAll("&quot;", '"')
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&"),
  );
}

describe.each([
  { label: "root", appUrl: "http://localhost:3000", base: "" },
  { label: "sub-path", appUrl: "https://example.test/bandroom/", base: "/bandroom" },
])("app at $label", ({ appUrl, base }) => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ APP_URL: appUrl, APP_NAME: "Test Band" });
  });
  afterAll(async () => {
    await t.close();
  });

  it("serves /healthz under the base path and at the root", async () => {
    for (const url of [`${base}/healthz`, "/healthz"]) {
      const res = await t.app.inject({ url });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ status: string; checks: { db: { ok: boolean } } }>();
      expect(["ok", "degraded"]).toContain(body.status);
      expect(body.checks.db.ok).toBe(true);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("serves the meta contract", async () => {
    const res = await t.app.inject({ url: `${base}/api/v1/meta` });
    expect(res.statusCode).toBe(200);
    const meta = MetaSchema.parse(res.json());
    expect(meta.instanceName).toBe("Test Band");
    expect(meta.locales).toEqual(["en", "cs"]);
  });

  it("prefers the instanceName setting over APP_NAME", async () => {
    setSetting(t.db, "instanceName", "Renamed Band");
    const meta = MetaSchema.parse((await t.app.inject({ url: `${base}/api/v1/meta` })).json());
    expect(meta.instanceName).toBe("Renamed Band");
    const html = (await t.app.inject({ url: `${base}/`, headers: HTML })).body;
    expect(ClientConfigSchema.parse(extractClientConfig(html)).appName).toBe("Renamed Band");
    setSetting(t.db, "instanceName", null);
  });

  it("returns JSON NOT_FOUND for unknown API routes", async () => {
    const res = await t.app.inject({ url: `${base}/api/v1/nope`, headers: HTML });
    expect(res.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("NOT_FOUND");
  });

  it("rejects API mutations without the CSRF header", async () => {
    const res = await t.app.inject({ method: "POST", url: `${base}/api/v1/meta` });
    expect(res.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(res.json()).code).toBe("CSRF_HEADER_MISSING");
  });

  it("passes the CSRF check with the header (then 404 for the unknown route)", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: `${base}/api/v1/meta`,
      headers: { "x-requested-with": "bandroom" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("sets security headers", async () => {
    const res = await t.app.inject({ url: `${base}/api/v1/meta` });
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
  });

  it("asks search engines not to index anything", async () => {
    const index = await t.app.inject({ url: `${base}/`, headers: HTML });
    expect(index.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    expect(index.body).toContain('<meta name="robots" content="noindex, nofollow, noarchive">');
    const robots = await t.app.inject({ url: "/robots.txt" });
    expect(robots.statusCode).toBe(200);
    expect(robots.body).toBe("User-agent: *\nDisallow: /\n");
    expect(robots.body).not.toContain("bandroom");
  });

  it("serves index.html with base href and client config", async () => {
    const res = await t.app.inject({ url: `${base}/`, headers: HTML });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body).toContain(`<base href="${base}/">`);
    const cfg = ClientConfigSchema.parse(extractClientConfig(res.body));
    expect(cfg).toMatchObject({ appName: "Test Band", basePath: base, defaultLocale: "en" });
  });

  it("falls back to index.html for client-side routes (deep link reload)", async () => {
    const res = await t.app.inject({ url: `${base}/projects/123/songs/4`, headers: HTML });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`<base href="${base}/">`);
    const head = await t.app.inject({ method: "HEAD", url: `${base}/settings`, headers: HTML });
    expect(head.statusCode).toBe(200);
  });

  it("does not serve SPA for non-HTML requests to unknown paths", async () => {
    const res = await t.app.inject({ url: `${base}/missing.png` });
    expect(res.statusCode).toBe(404);
  });

  it("serves hashed assets as immutable and other files as no-cache", async () => {
    const asset = await t.app.inject({ url: `${base}/assets/index-abc.js` });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const icon = await t.app.inject({ url: `${base}/favicon.svg` });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["cache-control"]).toBe("no-cache");
  });

  it("does not expose the raw index.html", async () => {
    const res = await t.app.inject({ url: `${base}/index.html` });
    expect(res.body).not.toContain(
      '<script type="module" src="./assets/index-abc.js"></script></head>',
    );
  });
});

describe("sub-path specifics", () => {
  it("redirects the bare base path to the trailing-slash URL", async () => {
    const t = await createTestApp({ APP_URL: "https://example.test/bandroom" });
    const res = await t.app.inject({ url: "/bandroom", headers: HTML });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/bandroom/");
    const outside = await t.app.inject({ url: "/other", headers: HTML });
    expect(outside.statusCode).toBe(404);
    await t.close();
  });
});

describe("validation errors", () => {
  it("map to VALIDATION_FAILED with field errors", async () => {
    const { z } = await import("zod");
    const { defineContract } = await import("@bandroom/shared");
    const { registerContract } = await import("./http/contracts");
    const { loadConfig, makeTempDir, openDb } = await import("@bandroom/server-core");
    const { buildApp } = await import("./app");
    const tmp = makeTempDir();
    const config = loadConfig({ NODE_ENV: "test", DATA_DIR: tmp.dir, LOG_LEVEL: "silent" });
    const db = openDb(config.dbPath);
    const app = await buildApp({ config, db });
    const echo = defineContract({
      method: "POST",
      path: "/echo/:n",
      params: z.object({ n: z.coerce.number().int() }),
      body: z.object({ text: z.string().min(1) }),
      response: z.object({ text: z.string(), n: z.number() }),
      auth: { public: true },
    });
    await app.register(
      (api, _o, done) => {
        registerContract(api, echo, ({ params, body }) => ({ text: body.text, n: params.n }));
        done();
      },
      { prefix: "/api/v1" },
    );
    const headers = { "x-requested-with": "bandroom" };
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/echo/5",
      headers,
      payload: { text: "hi" },
    });
    expect(ok.json()).toEqual({ text: "hi", n: 5 });
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/echo/5",
      headers,
      payload: { text: "" },
    });
    expect(bad.statusCode).toBe(400);
    const err = ApiErrorSchema.parse(bad.json());
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.fieldErrors?.[0]?.path).toBe("body/text");
    await app.close();
    db.$client.close();
    tmp.cleanup();
  });
});
