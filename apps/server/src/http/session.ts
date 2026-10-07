import type { Config, Db, SessionRow, UserRow } from "@bandroom/server-core";
import { resolveSession, SESSION_TTL_MS } from "@bandroom/server-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "bandroom_session";

declare module "fastify" {
  interface FastifyRequest {
    /** Authenticated, enabled user for this request (null = anonymous). */
    user: UserRow | null;
    session: SessionRow | null;
  }
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

/** Resolves the session cookie on API requests into `request.user` / `request.session`. */
export function installSessionResolution(
  app: FastifyInstance,
  db: Db,
  apiPrefix: string,
  cookies: CookieSettings,
): void {
  app.decorateRequest("user", null);
  app.decorateRequest("session", null);
  app.addHook("onRequest", (request: FastifyRequest, reply, done) => {
    if (!request.url.startsWith(`${apiPrefix}/`)) {
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
