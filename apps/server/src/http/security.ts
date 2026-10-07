import { createHash } from "node:crypto";
import { COLOR_SCHEME_SCRIPT } from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import { AppError } from "./errors";

/** CSP source allowing exactly one inline script. */
export function scriptHashSource(script: string): string {
  return `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`;
}

/**
 * Content Security Policy from SPEC §18.6. The only inline script is the color scheme script
 * that `index.html` gets from the server (no light/dark flash), allowed by its hash.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval' ${scriptHashSource(COLOR_SCHEME_SCRIPT)}`,
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const CSRF_HEADER = "x-requested-with";
export const CSRF_HEADER_VALUE = "bandroom";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The instance is private: no search engine may index, follow or cache any response. */
export const ROBOTS_TAG = "noindex, nofollow, noarchive";

/** Disallows crawling the whole site, without naming the base path (decision log). */
export const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

/**
 * Security headers on every response and the CSRF header check for API mutations.
 * HSTS is added by Caddy (HTTPS termination).
 */
export function installSecurity(app: FastifyInstance, apiPrefix: string): void {
  app.addHook("onRequest", (request, reply, done) => {
    reply.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)");
    reply.header("X-Robots-Tag", ROBOTS_TAG);

    const isMutation = !SAFE_METHODS.has(request.method);
    const isApi = request.url.startsWith(`${apiPrefix}/`);
    if (isMutation && isApi && request.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
      done(new AppError("CSRF_HEADER_MISSING", "Missing X-Requested-With header"));
      return;
    }
    done();
  });
}

/**
 * `GET /robots.txt` at the root. Reached only when the app owns the host (root deployment); at a
 * sub-path Caddy answers it for the whole site (deploy/Caddyfile.subpath).
 */
export function registerRobotsTxt(app: FastifyInstance): void {
  app.get("/robots.txt", (_request, reply) =>
    reply
      .type("text/plain; charset=utf-8")
      .header("Cache-Control", "public, max-age=86400")
      .send(ROBOTS_TXT),
  );
}
