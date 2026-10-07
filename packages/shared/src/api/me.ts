import { z } from "zod";
import {
  CurrentUserSchema,
  DisplayNameSchema,
  EmailSchema,
  PasswordSchema,
  SessionInfoSchema,
  ThemeSchema,
} from "../auth";
import { DocFontSizeSchema } from "../documents";
import { LocaleSchema } from "../locales";
import { OkSchema } from "./auth";
import { defineContract } from "./contract";

export const updateMe = defineContract({
  method: "PATCH",
  path: "/me",
  body: z
    .object({
      displayName: DisplayNameSchema,
      email: EmailSchema.nullable(),
      locale: LocaleSchema.nullable(),
      theme: ThemeSchema,
      instrumentTag: z.string().trim().max(40),
      docFontSize: DocFontSizeSchema,
    })
    .partial(),
  response: z.object({ user: CurrentUserSchema }),
  errors: ["EMAIL_TAKEN"],
  auth: { user: true },
});

/** Changes the password and revokes all other sessions. */
export const changePassword = defineContract({
  method: "POST",
  path: "/me/password",
  body: z.object({ currentPassword: z.string().min(1).max(256), newPassword: PasswordSchema }),
  response: OkSchema,
  errors: ["WRONG_PASSWORD", "RATE_LIMITED"],
  auth: { user: true },
});

export const listMySessions = defineContract({
  method: "GET",
  path: "/me/sessions",
  response: z.object({ sessions: z.array(SessionInfoSchema) }),
  auth: { user: true },
});

export const revokeMySession = defineContract({
  method: "DELETE",
  path: "/me/sessions/:id",
  params: z.object({ id: z.string().min(1).max(128) }),
  response: OkSchema,
  errors: ["NOT_FOUND"],
  auth: { user: true },
});

export const revokeMyOtherSessions = defineContract({
  method: "POST",
  path: "/me/sessions/revoke-others",
  response: z.object({ revoked: z.number() }),
  auth: { user: true },
});

/** Storage used by my uploads and my quota (null = unlimited), SPEC §15.1. */
export const getMyUsage = defineContract({
  method: "GET",
  path: "/me/usage",
  response: z.object({ usedBytes: z.number(), quotaBytes: z.number().nullable() }),
  auth: { user: true },
});
