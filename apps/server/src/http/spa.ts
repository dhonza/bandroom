import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { CLIENT_CONFIG_META_NAME, COLOR_SCHEME_SCRIPT, type ClientConfig } from "@bandroom/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ROBOTS_TAG } from "./security";

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Injects `<base href>`, the robots meta tag, the runtime client config and the color scheme script into the built
 * `index.html`, so a single build works under any base path (decision log,
 * "Runtime-configurable base path"), and names the page after `APP_NAME` (or the instance name).
 */
export function injectIndexHtml(html: string, clientConfig: ClientConfig): string {
  const name = escapeAttr(clientConfig.appName);
  const tags =
    `<base href="${escapeAttr(`${clientConfig.basePath}/`)}">` +
    `<meta name="robots" content="${ROBOTS_TAG}">` +
    `<meta name="${CLIENT_CONFIG_META_NAME}" content="${escapeAttr(JSON.stringify(clientConfig))}">` +
    `<script>${COLOR_SCHEME_SCRIPT}</script>`;
  if (!/<head>/i.test(html)) throw new Error("index.html has no <head> tag");
  return html
    .replace(/<head>/i, (m) => `${m}${tags}`)
    .replace(/<title>[^<]*<\/title>/i, () => `<title>${name}</title>`)
    .replace(
      /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/i,
      (_m, open: string, close: string) => `${open}${name}${close}`,
    );
}

/** The built web app manifest with the install name set to `APP_NAME` (or the instance name). */
export function patchManifest(json: string, appName: string): string {
  const manifest = JSON.parse(json) as Record<string, unknown>;
  return JSON.stringify({ ...manifest, name: appName, short_name: appName });
}

export interface SpaOptions {
  distDir: string;
  basePath: string;
  /** Evaluated per request so admin setting changes apply without a restart. */
  clientConfig: () => ClientConfig;
}

export interface Spa {
  sendIndex(reply: FastifyReply): FastifyReply;
}

/**
 * Serves the built SPA: hashed files under `assets/` are immutable, other static files are
 * revalidated, and `index.html` is served (injected) for `/` and as the client-side route
 * fallback (see the not-found handler in `app.ts`).
 */
export async function registerSpa(app: FastifyInstance, opts: SpaOptions): Promise<Spa> {
  const indexFile = path.join(opts.distDir, "index.html");
  const rawIndexHtml = fs.readFileSync(indexFile, "utf8");
  injectIndexHtml(rawIndexHtml, opts.clientConfig()); // fail fast on a malformed build
  const manifestFile = path.join(opts.distDir, "manifest.webmanifest");
  const rawManifest = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, "utf8") : null;
  if (rawManifest !== null) patchManifest(rawManifest, opts.clientConfig().appName);

  await app.register(fastifyStatic, {
    root: opts.distDir,
    prefix: `${opts.basePath}/`,
    index: false,
    wildcard: true,
    allowedPath: (pathName) => pathName !== "/index.html",
    setHeaders: (res, filePath) => {
      const rel = path.relative(opts.distDir, filePath);
      res.header(
        "Cache-Control",
        rel.startsWith(`assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
      );
    },
  });

  const spa: Spa = {
    sendIndex: (reply) =>
      reply
        .type("text/html; charset=utf-8")
        .header("Cache-Control", "no-cache")
        .send(injectIndexHtml(rawIndexHtml, opts.clientConfig())),
  };

  app.get(`${opts.basePath}/`, (_request, reply) => spa.sendIndex(reply));
  if (rawManifest !== null) {
    app.get(`${opts.basePath}/manifest.webmanifest`, (_request, reply) =>
      reply
        .type("application/manifest+json; charset=utf-8")
        .header("Cache-Control", "no-cache")
        .send(patchManifest(rawManifest, opts.clientConfig().appName)),
    );
  }
  if (opts.basePath !== "") {
    app.get(opts.basePath, (_request, reply) => reply.redirect(`${opts.basePath}/`));
  }
  return spa;
}
