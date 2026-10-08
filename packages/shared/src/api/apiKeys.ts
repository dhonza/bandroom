import { z } from "zod";
import { AdminApiKeyInfoSchema, ApiKeyInfoSchema, ApiKeyNameSchema } from "../apiKeys";
import { GlobalRoleSchema } from "../permissions/global";
import { ApiScopeSchema } from "../permissions/apiScopes";
import { OkSchema } from "./auth";
import { defineContract } from "./contract";

const KeyIdParams = z.object({ id: z.string().min(1).max(64) });

export const listMyApiKeys = defineContract({
  method: "GET",
  path: "/me/api-keys",
  response: z.object({ keys: z.array(ApiKeyInfoSchema) }),
  auth: { user: true },
  apiKey: false,
});

/** Creates a key; the token is in this response only (SPEC §29.4). */
export const createMyApiKey = defineContract({
  method: "POST",
  path: "/me/api-keys",
  body: z.object({
    name: ApiKeyNameSchema,
    scopes: z
      .array(ApiScopeSchema)
      .min(1)
      .max(4)
      .transform((s) => [...new Set(s)]),
    expiresInDays: z.number().int().min(1).max(3650).nullable(),
  }),
  response: z.object({ key: ApiKeyInfoSchema, token: z.string() }),
  errors: ["FORBIDDEN", "API_KEY_LIMIT"],
  auth: { user: true },
  apiKey: false,
});

export const revokeMyApiKey = defineContract({
  method: "DELETE",
  path: "/me/api-keys/:id",
  params: KeyIdParams,
  response: OkSchema,
  errors: ["NOT_FOUND"],
  auth: { user: true },
  apiKey: false,
});

export const adminListApiKeys = defineContract({
  method: "GET",
  path: "/admin/api-keys",
  response: z.object({ keys: z.array(AdminApiKeyInfoSchema) }),
  auth: { global: "admin.access" },
});

export const adminRevokeApiKey = defineContract({
  method: "POST",
  path: "/admin/api-keys/:id/revoke",
  params: KeyIdParams,
  response: OkSchema,
  errors: ["NOT_FOUND"],
  auth: { global: "admin.access" },
  apiKey: false,
});

/**
 * Who am I, through which key, on which server (SPEC §29.5): a client's "Test connection".
 * Also works with a session (`key: null`).
 */
export const getWhoami = defineContract({
  method: "GET",
  path: "/whoami",
  response: z.object({
    user: z.object({
      id: z.string(),
      username: z.string(),
      displayName: z.string(),
      globalRole: GlobalRoleSchema,
    }),
    key: z
      .object({
        id: z.string(),
        name: z.string(),
        scopes: z.array(ApiScopeSchema),
        expiresAt: z.number().nullable(),
      })
      .nullable(),
    server: z.object({ version: z.string(), maxUploadBytes: z.number() }),
    /** `quotaBytes` null = unlimited. */
    quota: z.object({ usedBytes: z.number(), quotaBytes: z.number().nullable() }),
  }),
  auth: { user: true },
});
