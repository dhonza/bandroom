import {
  ApiKeyLimitError,
  createApiKey,
  getUsage,
  listAllApiKeys,
  listUserApiKeys,
  revokeApiKey,
  toApiKeyInfo,
} from "@bandroom/server-core";
import {
  adminListApiKeys,
  adminRevokeApiKey,
  createMyApiKey,
  getWhoami,
  listMyApiKeys,
  revokeMyApiKey,
  scopesAllowedFor,
} from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract, userOrIpKey } from "../http/contracts";
import { AppError } from "../http/errors";
import { effectiveQuota } from "../quota";

/** API key management (SPEC §29.4). Keys themselves cannot reach these routes. */
export function registerApiKeyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  registerContract(app, getWhoami, ({ user }, request) => ({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      globalRole: user.globalRole,
    },
    key: request.apiKey,
    server: { version: ctx.version, maxUploadBytes: ctx.config.maxUploadBytes },
    quota: { usedBytes: getUsage(db, user.id), quotaBytes: effectiveQuota(ctx, user) },
  }));

  registerContract(app, listMyApiKeys, ({ user }) => ({ keys: listUserApiKeys(db, user.id) }));

  registerContract(
    app,
    createMyApiKey,
    ({ body, user }, request) => {
      if (!scopesAllowedFor(user.globalRole, body.scopes)) {
        throw new AppError("FORBIDDEN", "Admin scopes are for admins only");
      }
      let created;
      try {
        created = createApiKey(db, { userId: user.id, ...body });
      } catch (err) {
        if (err instanceof ApiKeyLimitError) throw new AppError("API_KEY_LIMIT", err.message);
        throw err;
      }
      const key = toApiKeyInfo(created.key);
      audit(db, request, {
        action: "auth.api_key_created",
        targetType: "apiKey",
        targetId: key.id,
        details: { name: key.name, scopes: key.scopes, expiresAt: key.expiresAt },
      });
      return { key, token: created.token };
    },
    { rateLimit: { max: 30, timeWindow: "1 hour", keyGenerator: userOrIpKey } },
  );

  registerContract(app, revokeMyApiKey, ({ params, user }, request) => {
    const revoked = revokeApiKey(db, params.id, { userId: user.id });
    if (!revoked) throw new AppError("NOT_FOUND", "API key not found");
    audit(db, request, {
      action: "auth.api_key_revoked",
      targetType: "apiKey",
      targetId: revoked.id,
      details: { name: revoked.name, byAdmin: false },
    });
    return { ok: true as const };
  });

  registerContract(app, adminListApiKeys, () => ({ keys: listAllApiKeys(db) }));

  registerContract(app, adminRevokeApiKey, ({ params }, request) => {
    const revoked = revokeApiKey(db, params.id);
    if (!revoked) throw new AppError("NOT_FOUND", "API key not found");
    audit(db, request, {
      action: "auth.api_key_revoked",
      targetType: "apiKey",
      targetId: revoked.id,
      details: { name: revoked.name, byAdmin: true, ownerId: revoked.userId },
    });
    return { ok: true as const };
  });
}
