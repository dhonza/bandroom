import { z } from "zod";
import { DirectoryUserSchema } from "../content";
import { ContentRoleSchema } from "../permissions/content";
import { LocaleSchema } from "../locales";
import { defineContract } from "./contract";

/** Active band members and guests (not for guests themselves). */
export const listUsersDirectory = defineContract({
  method: "GET",
  path: "/users",
  response: z.object({ users: z.array(DirectoryUserSchema) }),
  auth: { global: "users.directory" },
});

export const InstanceSettingsSchema = z.object({
  instanceName: z.string().min(1).max(80).nullable(),
  defaultLocale: LocaleSchema.nullable(),
  defaultProjectRoleMember: ContentRoleSchema,
  defaultProjectRoleGuest: ContentRoleSchema,
  /** Days before Trash items are purged (SPEC §26.3). */
  trashRetentionDays: z.number().int().min(1).max(3650),
});
export type InstanceSettings = z.infer<typeof InstanceSettingsSchema>;

/**
 * The branding logo (SPEC §25.1): the logo in use, and an upload still being processed or
 * rejected (`error` is an error code such as `LOGO_TOO_WIDE`). The previous logo stays in use
 * until a new one is ready.
 */
export const InstanceLogoSchema = z.object({
  hash: z.string().nullable(),
  pending: z
    .object({
      status: z.enum(["queued", "processing", "failed"]),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type InstanceLogo = z.infer<typeof InstanceLogoSchema>;

export const adminGetSettings = defineContract({
  method: "GET",
  path: "/admin/settings",
  response: z.object({ settings: InstanceSettingsSchema, logo: InstanceLogoSchema }),
  auth: { global: "admin.access" },
});

/** Removes the branding logo (and a pending upload). Uploads use the tus target `instanceLogo`. */
export const adminRemoveLogo = defineContract({
  method: "DELETE",
  path: "/admin/settings/logo",
  response: z.object({ logo: InstanceLogoSchema }),
  auth: { global: "admin.access" },
});

export const adminUpdateSettings = defineContract({
  method: "PATCH",
  path: "/admin/settings",
  body: InstanceSettingsSchema.partial(),
  response: z.object({ settings: InstanceSettingsSchema }),
  auth: { global: "admin.access" },
});
