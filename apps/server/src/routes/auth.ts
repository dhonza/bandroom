import {
  clearResetRequest,
  createSession,
  deleteSession,
  deleteUserSessions,
  findUsableInvite,
  findUsablePasswordReset,
  findUserByLogin,
  getUserById,
  hashPassword,
  insertUser,
  isUsernameTaken,
  markInviteUsed,
  markPasswordResetUsed,
  toCurrentUser,
  updateUser,
  upsertResetRequest,
  verifyAgainstDummy,
  verifyPassword,
} from "@bandroom/server-core";
import {
  acceptInvite,
  completePasswordReset,
  getInvite,
  getPasswordReset,
  getSession,
  login,
  logout,
  requestPasswordReset,
} from "@bandroom/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { registerContract } from "../http/contracts";
import { audit } from "../http/audit";
import { AppError } from "../http/errors";
import { clearSessionCookie, setSessionCookie } from "../http/session";
import { notifyResetRequest } from "../notify";

const PUBLIC_TOKEN_LIMIT = { max: 20, timeWindow: "15 minutes" } as const;

function meta(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers["user-agent"] ?? null };
}

function startSession(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
) {
  const { token, session } = createSession(ctx.db, userId, meta(request));
  setSessionCookie(reply, token, ctx.cookies);
  return session.id;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  registerContract(app, login, async ({ body }, request, reply) => {
    const typed = body.login.toLowerCase();
    const user = findUserByLogin(db, typed);
    // One failure budget per account, whether it is addressed by username or email.
    const key = user ? `u:${user.id}` : `l:${typed}`;
    const wait = ctx.throttle.retryAfterMs(key, request.ip);
    if (wait > 0) {
      throw new AppError("RATE_LIMITED", "Too many login attempts", {
        retryAfterSec: Math.ceil(wait / 1000),
      });
    }
    const ok = user
      ? (await verifyPassword(user.passwordHash, body.password)) && user.disabledAt === null
      : await verifyAgainstDummy(body.password);
    if (!user || !ok) {
      ctx.throttle.recordFailure(key, request.ip);
      request.log.warn({ login: typed, ip: request.ip }, "login failed");
      audit(db, request, {
        action: "auth.login_failed",
        actorUserId: user?.id ?? null,
        actorType: "user",
        targetType: "user",
        targetId: user?.id ?? null,
        details: { login: typed },
      });
      throw new AppError("INVALID_CREDENTIALS", "Invalid credentials");
    }
    ctx.throttle.recordSuccess(key);
    const sessionId = startSession(ctx, request, reply, user.id);
    request.log.info({ userId: user.id }, "login");
    audit(db, request, {
      action: "auth.login",
      actorUserId: user.id,
      sessionId,
      targetType: "user",
      targetId: user.id,
    });
    return { user: toCurrentUser(user) };
  });

  registerContract(app, logout, ({ user }, request, reply) => {
    if (user) {
      request.log.info({ userId: user.id }, "logout");
      audit(db, request, { action: "auth.logout", targetType: "user", targetId: user.id });
    }
    if (request.session) deleteSession(db, request.session.id);
    if (user) ctx.hub.revalidateUser(user.id);
    clearSessionCookie(reply, ctx.cookies);
    return { ok: true as const };
  });

  registerContract(app, getSession, ({ user }) => ({ user: user && toCurrentUser(user) }));

  registerContract(
    app,
    requestPasswordReset,
    ({ body }, request) => {
      const user = findUserByLogin(db, body.login);
      if (user && user.disabledAt === null) {
        upsertResetRequest(db, user.id, request.ip);
        request.log.info({ userId: user.id }, "password reset requested");
        audit(db, request, {
          action: "auth.reset_requested",
          actorUserId: user.id,
          targetType: "user",
          targetId: user.id,
        });
        notifyResetRequest(ctx, user);
      }
      return { ok: true as const };
    },
    { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  );

  registerContract(
    app,
    getInvite,
    ({ params }) => {
      const invite = findUsableInvite(db, params.token);
      if (!invite) throw new AppError("TOKEN_INVALID", "Invite is invalid or expired");
      return { globalRole: invite.globalRole, expiresAt: invite.expiresAt };
    },
    { rateLimit: PUBLIC_TOKEN_LIMIT },
  );

  registerContract(
    app,
    acceptInvite,
    async ({ params, body }, request, reply) => {
      if (!findUsableInvite(db, params.token)) {
        throw new AppError("TOKEN_INVALID", "Invite is invalid or expired");
      }
      const passwordHash = await hashPassword(body.password);
      // Re-check inside the transaction: the hash above takes time and the invite is single-use.
      const user = db.transaction(() => {
        const invite = findUsableInvite(db, params.token);
        if (!invite) throw new AppError("TOKEN_INVALID", "Invite is invalid or expired");
        if (isUsernameTaken(db, body.username)) {
          throw new AppError("USERNAME_TAKEN", "Username is taken");
        }
        const created = insertUser(db, {
          username: body.username,
          displayName: body.displayName,
          passwordHash,
          globalRole: invite.globalRole,
          locale: body.locale,
        });
        markInviteUsed(db, invite.id, created.id);
        return created;
      });
      const sessionId = startSession(ctx, request, reply, user.id);
      request.log.info({ userId: user.id }, "invite accepted");
      audit(db, request, {
        action: "invite.accepted",
        actorUserId: user.id,
        sessionId,
        targetType: "user",
        targetId: user.id,
        details: { globalRole: user.globalRole },
      });
      return { user: toCurrentUser(user) };
    },
    { rateLimit: PUBLIC_TOKEN_LIMIT },
  );

  function usableReset(token: string) {
    const reset = findUsablePasswordReset(db, token);
    const user = reset && getUserById(db, reset.userId);
    if (!reset || !user || user.disabledAt !== null) {
      throw new AppError("TOKEN_INVALID", "Reset link is invalid or expired");
    }
    return { reset, user };
  }

  registerContract(
    app,
    getPasswordReset,
    ({ params }) => {
      const { reset, user } = usableReset(params.token);
      return { username: user.username, expiresAt: reset.expiresAt };
    },
    { rateLimit: PUBLIC_TOKEN_LIMIT },
  );

  registerContract(
    app,
    completePasswordReset,
    async ({ params, body }, request, reply) => {
      usableReset(params.token);
      const passwordHash = await hashPassword(body.password);
      const user = db.transaction(() => {
        const { reset, user: target } = usableReset(params.token);
        const updated = updateUser(db, target.id, { passwordHash }) ?? target;
        markPasswordResetUsed(db, reset.tokenHash);
        deleteUserSessions(db, target.id);
        clearResetRequest(db, target.id);
        return updated;
      });
      ctx.hub.revalidateUser(user.id);
      const sessionId = startSession(ctx, request, reply, user.id);
      request.log.info({ userId: user.id }, "password reset completed");
      audit(db, request, {
        action: "auth.password_reset",
        actorUserId: user.id,
        sessionId,
        targetType: "user",
        targetId: user.id,
      });
      return { user: toCurrentUser(user) };
    },
    { rateLimit: PUBLIC_TOKEN_LIMIT },
  );
}
