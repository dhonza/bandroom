import { z } from "zod";
import {
  AdminUserSchema,
  DisplayNameSchema,
  EmailSchema,
  InviteInfoSchema,
  OneTimeLinkSchema,
  PasswordSchema,
  QuotaSchema,
  UsernameSchema,
} from "../auth";
import { GlobalRoleSchema } from "../permissions/global";
import { OkSchema } from "./auth";
import { defineContract } from "./contract";

const admin = { global: "admin.access" } as const;
const UserIdParams = z.object({ id: z.string().min(1).max(64) });

export const adminListUsers = defineContract({
  method: "GET",
  path: "/admin/users",
  response: z.object({ users: z.array(AdminUserSchema) }),
  auth: admin,
});

/** Creates a user directly with an initial password (SPEC §3.1 "created directly by an admin"). */
export const adminCreateUser = defineContract({
  method: "POST",
  path: "/admin/users",
  body: z.object({
    username: UsernameSchema,
    displayName: DisplayNameSchema,
    email: EmailSchema.nullable().optional(),
    globalRole: GlobalRoleSchema,
    password: PasswordSchema,
    quotaBytes: QuotaSchema.optional(),
  }),
  response: z.object({ user: AdminUserSchema }),
  errors: ["USERNAME_TAKEN", "EMAIL_TAKEN"],
  auth: admin,
  apiKey: false,
});

export const adminUpdateUser = defineContract({
  method: "PATCH",
  path: "/admin/users/:id",
  params: UserIdParams,
  body: z
    .object({
      displayName: DisplayNameSchema,
      email: EmailSchema.nullable(),
      globalRole: GlobalRoleSchema,
      disabled: z.boolean(),
      quotaBytes: QuotaSchema,
    })
    .partial(),
  response: z.object({ user: AdminUserSchema }),
  errors: ["NOT_FOUND", "EMAIL_TAKEN", "LAST_ADMIN"],
  auth: admin,
  apiKey: false,
});

/** One-time password reset link (valid 24 h); also resolves a pending reset request. */
export const adminCreateResetLink = defineContract({
  method: "POST",
  path: "/admin/users/:id/reset-link",
  params: UserIdParams,
  response: OneTimeLinkSchema,
  errors: ["NOT_FOUND"],
  auth: admin,
  apiKey: false,
});

export const adminDismissResetRequest = defineContract({
  method: "DELETE",
  path: "/admin/users/:id/reset-request",
  params: UserIdParams,
  response: OkSchema,
  auth: admin,
  apiKey: false,
});

export const adminListInvites = defineContract({
  method: "GET",
  path: "/admin/invites",
  response: z.object({ invites: z.array(InviteInfoSchema) }),
  auth: admin,
});

export const adminCreateInvite = defineContract({
  method: "POST",
  path: "/admin/invites",
  body: z.object({
    globalRole: GlobalRoleSchema,
    note: z.string().trim().max(200).nullable().optional(),
    expiresInDays: z.number().int().min(1).max(30).default(7),
  }),
  response: z.object({ invite: InviteInfoSchema, link: OneTimeLinkSchema }),
  auth: admin,
  apiKey: false,
});

export const adminRevokeInvite = defineContract({
  method: "DELETE",
  path: "/admin/invites/:id",
  params: UserIdParams,
  response: OkSchema,
  errors: ["NOT_FOUND"],
  auth: admin,
  apiKey: false,
});
