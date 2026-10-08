import { z } from "zod";
import { GlobalRoleSchema } from "./permissions/global";
import { ApiScopeSchema } from "./permissions/apiScopes";

/** Most active keys one user may have (SPEC §29.1). */
export const MAX_API_KEYS_PER_USER = 20;
/** Expiry choices offered by the UI; `null` = never. */
export const API_KEY_EXPIRY_DAYS = [30, 90, 365] as const;

export const ApiKeyInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The token's first characters, e.g. `brk_AbCdEf`. */
  prefix: z.string(),
  scopes: z.array(ApiScopeSchema),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  lastUsedIp: z.string().nullable(),
  expiresAt: z.number().nullable(),
});
export type ApiKeyInfo = z.infer<typeof ApiKeyInfoSchema>;

export const AdminApiKeyInfoSchema = ApiKeyInfoSchema.extend({
  userId: z.string(),
  username: z.string(),
  displayName: z.string(),
  globalRole: GlobalRoleSchema,
});
export type AdminApiKeyInfo = z.infer<typeof AdminApiKeyInfoSchema>;

export const ApiKeyNameSchema = z.string().trim().min(1).max(80);
