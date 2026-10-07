import { z } from "zod";
import { LocaleSchema } from "./locales";
import { GlobalRoleSchema } from "./permissions/global";

/** Lowercase, 3–32 chars, starts with a letter or digit (SPEC §4.1: unique, lowercase). */
export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, "USERNAME_FORMAT");

export const PASSWORD_MIN_LENGTH = 10;
export const PasswordSchema = z.string().min(PASSWORD_MIN_LENGTH, "PASSWORD_TOO_SHORT").max(256);

export const DisplayNameSchema = z.string().trim().min(1).max(80);

/** Optional alternative login name (no email is ever sent — decision log). */
export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const THEMES = ["dark", "light", "system"] as const;
export const ThemeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof ThemeSchema>;

export const CurrentUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().nullable(),
  displayName: z.string(),
  globalRole: GlobalRoleSchema,
  locale: LocaleSchema.nullable(),
  theme: ThemeSchema,
  /** "My instrument", matched against track instrument tags (SPEC §11.3). */
  instrumentTag: z.string(),
  /** Document viewer font size in px (SPEC §10). */
  docFontSize: z.number(),
  createdAt: z.number(),
});
export type CurrentUser = z.infer<typeof CurrentUserSchema>;

export const SessionInfoSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  expiresAt: z.number(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const AdminUserSchema = CurrentUserSchema.extend({
  disabledAt: z.number().nullable(),
  lastSeenAt: z.number().nullable(),
  resetRequestedAt: z.number().nullable(),
  /** null = instance default, -1 = unlimited. */
  quotaBytes: z.number().nullable(),
  usedBytes: z.number(),
});

/** null = instance default, -1 = unlimited (SPEC §4.1). */
export const QuotaSchema = z.number().int().min(-1).nullable();
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const InviteInfoSchema = z.object({
  id: z.string(),
  globalRole: GlobalRoleSchema,
  note: z.string().nullable(),
  createdAt: z.number(),
  expiresAt: z.number(),
  usedAt: z.number().nullable(),
  usedByUsername: z.string().nullable(),
  revokedAt: z.number().nullable(),
  createdByDisplayName: z.string().nullable(),
});
export type InviteInfo = z.infer<typeof InviteInfoSchema>;

/** A freshly created one-time link; the token is only ever returned once. */
export const OneTimeLinkSchema = z.object({
  url: z.string(),
  expiresAt: z.number(),
});
