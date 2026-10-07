import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COLOR_SCHEME_SCRIPT, type ClientConfig } from "@bandroom/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY, scriptHashSource } from "./security";
import { injectIndexHtml, patchManifest, registerSpa } from "./spa";

const INDEX = `<!doctype html>
<html lang="en" data-mantine-color-scheme="dark">
  <head>
    <meta name="apple-mobile-web-app-title" content="BandRoom" />
    <title>BandRoom</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

const MANIFEST = JSON.stringify({ name: "BandRoom", short_name: "BandRoom", start_url: "./" });

const config = (over: Partial<ClientConfig> = {}): ClientConfig => ({
  appName: "BandRoom",
  version: "1.0.0",
  basePath: "",
  defaultLocale: "en",
  logoHash: null,
  ...over,
});

describe("injectIndexHtml", () => {
  it("injects the base, the runtime config and the color scheme script first in <head>", () => {
    const html = injectIndexHtml(INDEX, config({ basePath: "/bandroom" }));
    const head = html.slice(html.indexOf("<head>") + 6);
    expect(head.startsWith('<base href="/bandroom/">')).toBe(true);
    expect(html).toContain('<meta name="bandroom-config" content="{&quot;appName&quot;');
    expect(html).toContain(`<script>${COLOR_SCHEME_SCRIPT}</script>`);
    // Before any stylesheet or app script: the scheme is set before the first paint.
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf("<title>"));
  });

  it("names the page and the home screen title after the app name, escaped", () => {
    const html = injectIndexHtml(INDEX, config({ appName: 'Kapela & "Přátelé" <3' }));
    const escaped = "Kapela &amp; &quot;Přátelé&quot; &lt;3";
    expect(html).toContain(`<title>${escaped}</title>`);
    expect(html).toContain(`<meta name="apple-mobile-web-app-title" content="${escaped}" />`);
    expect(html).not.toContain("BandRoom</title>");
  });

  it("refuses a build without <head>", () => {
    expect(() => injectIndexHtml("<html></html>", config())).toThrow("no <head>");
  });

  it("allows exactly the injected script in the CSP", () => {
    expect(scriptHashSource("x")).toBe("'sha256-LXEWQrcmsEQBYnyp+6wy9chTD7GQPMTbAiWHF5IaSIE='");
    const scriptSrc = CONTENT_SECURITY_POLICY.split("; ").find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBe(
      `script-src 'self' 'wasm-unsafe-eval' ${scriptHashSource(COLOR_SCHEME_SCRIPT)}`,
    );
    expect(scriptSrc).not.toContain("unsafe-inline");
  });
});

describe("color scheme script", () => {
  const run = (stored: string | null, prefersDark = false): string | null => {
    let attr: string | null = null;
    const env = {
      localStorage: { getItem: () => stored },
      matchMedia: () => ({ matches: prefersDark }),
      document: {
        documentElement: {
          setAttribute: (_name: string, value: string) => {
            attr = value;
          },
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- evaluating the exact script
    const script = new Function("localStorage", "matchMedia", "document", COLOR_SCHEME_SCRIPT) as (
      ...args: unknown[]
    ) => void;
    script(env.localStorage, env.matchMedia, env.document);
    return attr;
  };

  it("defaults to dark and follows the stored or system choice", () => {
    expect(run(null)).toBe("dark");
    expect(run("bogus")).toBe("dark");
    expect(run("light")).toBe("light");
    expect(run("dark")).toBe("dark");
    expect(run("auto", false)).toBe("light");
    expect(run("auto", true)).toBe("dark");
  });
});

describe("patchManifest", () => {
  it("sets the install names and keeps the rest", () => {
    expect(JSON.parse(patchManifest(MANIFEST, "Kapela"))).toEqual({
      name: "Kapela",
      short_name: "Kapela",
      start_url: "./",
    });
  });
});

describe("registerSpa", () => {
  let dir: string;
  let app: FastifyInstance;
  let appName: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bandroom-spa-"));
    fs.writeFileSync(path.join(dir, "index.html"), INDEX);
    fs.writeFileSync(path.join(dir, "manifest.webmanifest"), MANIFEST);
    fs.writeFileSync(path.join(dir, "favicon.svg"), "<svg/>");
    appName = "BandRoom";
    app = Fastify();
  });
  afterEach(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves index.html and the manifest with the current app name", async () => {
    await registerSpa(app, {
      distDir: dir,
      basePath: "/bandroom",
      clientConfig: () => config({ appName, basePath: "/bandroom" }),
    });
    appName = "Garáž";
    const index = await app.inject({ method: "GET", url: "/bandroom/" });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("<title>Garáž</title>");
    const manifest = await app.inject({ method: "GET", url: "/bandroom/manifest.webmanifest" });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers["content-type"]).toContain("application/manifest+json");
    expect(manifest.headers["cache-control"]).toBe("no-cache");
    expect(manifest.json()).toMatchObject({ name: "Garáž", short_name: "Garáž" });
    // Other static files are still served from the build.
    const icon = await app.inject({ method: "GET", url: "/bandroom/favicon.svg" });
    expect(icon.statusCode).toBe(200);
  });

  it("works with a build that has no manifest", async () => {
    fs.rmSync(path.join(dir, "manifest.webmanifest"));
    await registerSpa(app, { distDir: dir, basePath: "", clientConfig: () => config() });
    const manifest = await app.inject({ method: "GET", url: "/manifest.webmanifest" });
    expect(manifest.statusCode).toBe(404);
  });
});
