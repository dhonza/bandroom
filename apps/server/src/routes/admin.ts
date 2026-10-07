import {
  clearResetRequest,
  countActiveAdmins,
  createInvite,
  createPasswordReset,
  deleteUserSecret,
  deleteUserSessions,
  getAdminUser,
  getUserById,
  hashPassword,
  insertUser,
  isEmailTaken,
  isUsernameTaken,
  listInvites,
  listUsersForAdmin,
  revokeInvite,
  toAdminUser,
  toInviteInfo,
  updateUser,
  type UserPatch,
} from "@bandroom/server-core";
import {
  adminCreateInvite,
  adminCreateResetLink,
  adminCreateUser,
  adminDismissResetRequest,
  adminListInvites,
  adminListUsers,
  adminRevokeInvite,
  adminUpdateUser,
} from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import { appLink, type AppContext } from "../context";
import { registerContract } from "../http/contracts";
import { audit } from "../http/audit";
import { AppError } from "../http/errors";

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  registerContract(app, adminListUsers, () => ({ users: listUsersForAdmin(db) }));

  registerContract(app, adminCreateUser, async ({ body, user: admin }, request) => {
    if (isUsernameTaken(db, body.username))
      throw new AppError("USERNAME_TAKEN", "Username is taken");
    if (body.email != null && isEmailTaken(db, body.email)) {
      throw new AppError("EMAIL_TAKEN", "Email is already in use");
    }
    const created = insertUser(db, {
      username: body.username,
      displayName: body.displayName,
      email: body.email ?? null,
      globalRole: body.globalRole,
      passwordHash: await hashPassword(body.password),
      quotaBytes: body.quotaBytes ?? null,
    });
    request.log.info({ userId: created.id, by: admin.id }, "user created");
    audit(db, request, {
      action: "user.created",
      targetType: "user",
      targetId: created.id,
      details: { username: created.username, globalRole: created.globalRole },
    });
    return { user: toAdminUser(created, null) };
  });

  registerContract(app, adminUpdateUser, ({ params, body, user: admin }, request) => {
    const target = getUserById(db, params.id);
    if (!target) throw new AppError("NOT_FOUND", "User not found");
    if (body.email != null && isEmailTaken(db, body.email, target.id)) {
      throw new AppError("EMAIL_TAKEN", "Email is already in use");
    }
    const losesAdmin =
      target.globalRole === "admin" &&
      target.disabledAt === null &&
      ((body.globalRole !== undefined && body.globalRole !== "admin") || body.disabled === true);
    if (losesAdmin && countActiveAdmins(db) <= 1) {
      throw new AppError("LAST_ADMIN", "The last admin cannot be demoted or disabled");
    }

    const { disabled, ...rest } = body;
    const patch: UserPatch = { ...rest };
    if (disabled === true && target.disabledAt === null) patch.disabledAt = Date.now();
    if (disabled === false) patch.disabledAt = null;
    const demoted = body.globalRole !== undefined && body.globalRole !== "admin";
    const secretDropped = db.transaction(() => {
      updateUser(db, target.id, patch);
      if (patch.disabledAt) deleteUserSessions(db, target.id);
      // A saved Samply key is only usable by admins (SPEC §25.11); it goes with the role.
      return demoted && deleteUserSecret(db, target.id, "samply");
    });
    ctx.hub.revalidateUser(target.id); // disabled or role changed: open streams end
    request.log.info(
      { userId: target.id, by: admin.id, changes: Object.keys(body) },
      "user updated",
    );
    const base = { targetType: "user", targetId: target.id } as const;
    if (body.quotaBytes !== undefined && body.quotaBytes !== target.quotaBytes) {
      audit(db, request, {
        ...base,
        action: "user.quota_changed",
        details: { before: target.quotaBytes, after: body.quotaBytes },
      });
    }
    if (Object.keys(rest).some((k) => k !== "globalRole" && k !== "quotaBytes")) {
      audit(db, request, {
        ...base,
        action: "user.updated",
        details: { changes: Object.keys(rest) },
      });
    }
    if (body.globalRole !== undefined && body.globalRole !== target.globalRole) {
      audit(db, request, {
        ...base,
        action: "user.role_changed",
        details: { before: target.globalRole, after: body.globalRole },
      });
    }
    if (secretDropped) {
      audit(db, request, {
        ...base,
        action: "secret.deleted",
        details: { kind: "samply", reason: "role_changed" },
      });
    }
    if (
      patch.disabledAt !== undefined &&
      (patch.disabledAt === null) !== (target.disabledAt === null)
    ) {
      audit(db, request, {
        ...base,
        action: patch.disabledAt === null ? "user.enabled" : "user.disabled",
      });
    }
    const updated = getAdminUser(db, target.id);
    if (!updated) throw new AppError("NOT_FOUND", "User not found");
    return { user: updated };
  });

  registerContract(app, adminCreateResetLink, ({ params, user: admin }, request) => {
    const target = getUserById(db, params.id);
    if (!target) throw new AppError("NOT_FOUND", "User not found");
    const { token, reset } = createPasswordReset(db, target.id, admin.id);
    clearResetRequest(db, target.id);
    request.log.info({ userId: target.id, by: admin.id }, "reset link created");
    audit(db, request, {
      action: "auth.reset_link_created",
      targetType: "user",
      targetId: target.id,
    });
    return { url: appLink(ctx, `/reset/${token}`), expiresAt: reset.expiresAt };
  });

  registerContract(app, adminDismissResetRequest, ({ params }, request) => {
    db.transaction(() => {
      if (clearResetRequest(db, params.id)) {
        audit(db, request, {
          action: "auth.reset_request_dismissed",
          targetType: "user",
          targetId: params.id,
        });
      }
    });
    return { ok: true as const };
  });

  registerContract(app, adminListInvites, () => ({ invites: listInvites(db) }));

  registerContract(app, adminCreateInvite, ({ body, user: admin }, request) => {
    const { token, invite } = createInvite(db, {
      globalRole: body.globalRole,
      note: body.note ?? null,
      createdBy: admin.id,
      expiresInDays: body.expiresInDays,
    });
    request.log.info({ inviteId: invite.id, by: admin.id }, "invite created");
    audit(db, request, {
      action: "user.invited",
      targetType: "invite",
      targetId: invite.id,
      details: { globalRole: invite.globalRole, note: invite.note },
    });
    return {
      invite: toInviteInfo(invite, admin.displayName, null),
      link: { url: appLink(ctx, `/invite/${token}`), expiresAt: invite.expiresAt },
    };
  });

  registerContract(app, adminRevokeInvite, ({ params }, request) => {
    if (!revokeInvite(db, params.id)) throw new AppError("NOT_FOUND", "Invite not found");
    audit(db, request, { action: "invite.revoked", targetType: "invite", targetId: params.id });
    return { ok: true as const };
  });
}
