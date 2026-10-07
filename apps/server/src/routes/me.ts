import {
  deleteSession,
  getUsage,
  deleteUserSessions,
  hashPassword,
  isEmailTaken,
  listUserSessions,
  toCurrentUser,
  updateUser,
  verifyPassword,
} from "@bandroom/server-core";
import {
  getMyUsage,
  changePassword,
  listMySessions,
  revokeMyOtherSessions,
  revokeMySession,
  updateMe,
} from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { registerContract } from "../http/contracts";
import { audit } from "../http/audit";
import { AppError } from "../http/errors";
import { clearSessionCookie } from "../http/session";
import { effectiveQuota } from "../quota";

export function registerMeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  registerContract(app, updateMe, ({ body, user }, request) => {
    if (body.email != null && isEmailTaken(db, body.email, user.id)) {
      throw new AppError("EMAIL_TAKEN", "Email is already in use");
    }
    const updated = updateUser(db, user.id, body) ?? user;
    audit(db, request, {
      action: "user.updated",
      targetType: "user",
      targetId: user.id,
      details: { changes: Object.keys(body), self: true },
    });
    return { user: toCurrentUser(updated) };
  });

  registerContract(
    app,
    changePassword,
    async ({ body, user }, request) => {
      if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
        throw new AppError("WRONG_PASSWORD", "Current password is wrong");
      }
      updateUser(db, user.id, { passwordHash: await hashPassword(body.newPassword) });
      deleteUserSessions(db, user.id, request.session?.id);
      ctx.hub.revalidateUser(user.id);
      request.log.info({ userId: user.id }, "password changed");
      audit(db, request, {
        action: "auth.password_changed",
        targetType: "user",
        targetId: user.id,
      });
      return { ok: true as const };
    },
    { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  );

  registerContract(app, getMyUsage, ({ user }) => ({
    usedBytes: getUsage(db, user.id),
    quotaBytes: effectiveQuota(ctx, user),
  }));

  registerContract(app, listMySessions, ({ user }, request) => ({
    sessions: listUserSessions(db, user.id, request.session?.id ?? null),
  }));

  registerContract(app, revokeMySession, ({ params, user }, request, reply) => {
    if (!deleteSession(db, params.id, user.id)) {
      throw new AppError("NOT_FOUND", "Session not found");
    }
    ctx.hub.revalidateUser(user.id);
    audit(db, request, {
      action: "auth.sessions_revoked",
      targetType: "user",
      targetId: user.id,
      details: { revoked: 1 },
    });
    if (params.id === request.session?.id) clearSessionCookie(reply, ctx.cookies);
    return { ok: true as const };
  });

  registerContract(app, revokeMyOtherSessions, ({ user }, request) => {
    const revoked = deleteUserSessions(db, user.id, request.session?.id);
    ctx.hub.revalidateUser(user.id);
    audit(db, request, {
      action: "auth.sessions_revoked",
      targetType: "user",
      targetId: user.id,
      details: { revoked },
    });
    return { revoked };
  });
}
