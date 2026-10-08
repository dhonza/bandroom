import type { Config, Db, SessionRow, UserRow } from "@bandroom/server-core";
import { resolveApiKey, resolveSession, SESSION_TTL_MS } from "@bandroom/server-core";
import type { ApiScope } from "@bandroom/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "./errors";

export const SESSION_COOKIE = "bandroom_session";

declare module "fastify" {
  interface FastifyRequest {
    /** Authenticated, enabled user for this request (null = anonymous). */
    user: UserRow | null;
    session: SessionRow | null;
    /** The API key of a bearer request (SPEC §29.3); null for cookie sessions. */
    apiKey: { id: string; name: string; scopes: ApiScope[]; expiresAt: number | null } | null;
  }
}

/**
 * The token of an `Authorization: Bearer …` header, or null without one. Other schemes are
 * ignored (the request then falls back to the session cookie).
 */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  return match?.[1] ?? null;
}

export interface CookieSettings {
  path: string;
  secure: boolean;
}

/** Cookie scope follows the base path, so it never leaks to other apps on the same host. */
export function cookieSettings(config: Pick<Config, "basePath" | "appUrl">): CookieSettings {
  return {
    path: config.basePath === "" ? "/" : config.basePath,
    secure: config.appUrl.startsWith("https:"),
  };
}

export function setSessionCookie(reply: FastifyReply, token: string, c: CookieSettings): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: c.path,
    httpOnly: true,
    secure: c.secure,
    sameSite: "lax",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, c: CookieSettings): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: c.path,
    httpOnly: true,
    secure: c.secure,
    sameSite: "lax",
  });
}

/**
 * Resolves API requests into `request.user`: a bearer API key (cookies are then ignored, and a
 * key that does not resolve is refused, SPEC §29.3), else the session cookie.
 */
export function installSessionResolution(
  app: FastifyInstance,
  db: Db,
  apiPrefix: string,
  cookies: CookieSettings,
): void {
  app.decorateRequest("user", null);
  app.decorateRequest("session", null);
  app.decorateRequest("apiKey", null);
  app.addHook("onRequest", (request: FastifyRequest, reply, done) => {
    if (!request.url.startsWith(`${apiPrefix}/`)) {
      done();
      return;
    }
    const bearer = bearerToken(request.headers.authorization);
    if (bearer !== null) {
      const key = resolveApiKey(db, bearer, { ip: request.ip });
      if (!key) {
        done(new AppError("API_KEY_INVALID", "Invalid API key"));
        return;
      }
      request.user = key.user;
      request.apiKey = {
        id: key.key.id,
        name: key.key.name,
        scopes: key.scopes,
        expiresAt: key.key.expiresAt,
      };
      done();
      return;
    }
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const resolved = resolveSession(db, token);
      if (resolved) {
        request.user = resolved.user;
        request.session = resolved.session;
      } else {
        clearSessionCookie(reply, cookies);
      }
    }
    done();
  });
}
