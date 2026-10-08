import { z } from "zod";
import { CurrentUserSchema, DisplayNameSchema, PasswordSchema, UsernameSchema } from "../auth";
import { LocaleSchema } from "../locales";
import { GlobalRoleSchema } from "../permissions/global";
import { defineContract } from "./contract";

export const OkSchema = z.object({ ok: z.literal(true) });

export const login = defineContract({
  method: "POST",
  path: "/auth/login",
  body: z.object({
    login: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(256),
  }),
  response: z.object({ user: CurrentUserSchema }),
  errors: ["INVALID_CREDENTIALS", "RATE_LIMITED"],
  auth: { public: true },
  apiKey: false,
});

export const logout = defineContract({
  method: "POST",
  path: "/auth/logout",
  response: OkSchema,
  auth: { public: true },
  apiKey: false,
});

/** Current session's user, or `user: null` when not logged in (never 401, so the SPA can boot). */
export const getSession = defineContract({
  method: "GET",
  path: "/auth/session",
  response: z.object({ user: CurrentUserSchema.nullable() }),
  auth: { public: true },
  apiKey: false,
});

/** "Forgot password?": records a request for admins. Same response whether the account exists. */
export const requestPasswordReset = defineContract({
  method: "POST",
  path: "/auth/reset-requests",
  body: z.object({ login: z.string().trim().min(1).max(254) }),
  response: OkSchema,
  errors: ["RATE_LIMITED"],
  auth: { public: true },
  apiKey: false,
});

export const getInvite = defineContract({
  method: "GET",
  path: "/invites/:token",
  params: z.object({ token: z.string().min(1).max(128) }),
  response: z.object({ globalRole: GlobalRoleSchema, expiresAt: z.number() }),
  errors: ["TOKEN_INVALID"],
  auth: { public: true },
  apiKey: false,
});

export const acceptInvite = defineContract({
  method: "POST",
  path: "/invites/:token/accept",
  params: z.object({ token: z.string().min(1).max(128) }),
  body: z.object({
    username: UsernameSchema,
    displayName: DisplayNameSchema,
    password: PasswordSchema,
    locale: LocaleSchema,
  }),
  response: z.object({ user: CurrentUserSchema }),
  errors: ["TOKEN_INVALID", "USERNAME_TAKEN", "RATE_LIMITED"],
  auth: { public: true },
  apiKey: false,
});

export const getPasswordReset = defineContract({
  method: "GET",
  path: "/password-resets/:token",
  params: z.object({ token: z.string().min(1).max(128) }),
  response: z.object({ username: z.string(), expiresAt: z.number() }),
  errors: ["TOKEN_INVALID"],
  auth: { public: true },
  apiKey: false,
});

/** Sets a new password, revokes all sessions, and logs the user in on this device. */
export const completePasswordReset = defineContract({
  method: "POST",
  path: "/password-resets/:token",
  params: z.object({ token: z.string().min(1).max(128) }),
  body: z.object({ password: PasswordSchema }),
  response: z.object({ user: CurrentUserSchema }),
  errors: ["TOKEN_INVALID", "RATE_LIMITED"],
  auth: { public: true },
  apiKey: false,
});
