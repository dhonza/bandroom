import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Identity (SPEC §4.1).

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    /** Unique, lowercase. */
    username: text("username").notNull().unique(),
    /** Optional alternative login name; never used to send email (decision log). */
    email: text("email").unique(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    globalRole: text("global_role", { enum: ["admin", "member", "guest"] }).notNull(),
    locale: text("locale", { enum: ["en", "cs"] }),
    theme: text("theme", { enum: ["dark", "light", "system"] })
      .notNull()
      .default("dark"),
    avatarBlobHash: text("avatar_blob_hash"),
    /** "My instrument" (e.g. "bass"), matched against tracks.instrumentTag (SPEC §11.3). */
    instrumentTag: text("instrument_tag").notNull().default(""),
    /** Document viewer font size in px (SPEC §10: font-size slider persisted per user). */
    docFontSize: integer("doc_font_size").notNull().default(18),
    /** null = instance default, -1 = unlimited (enforced from M3). */
    quotaBytes: integer("quota_bytes"),
    createdAt: integer("created_at").notNull(),
    disabledAt: integer("disabled_at"),
    deletedAt: integer("deleted_at"),
    lastSeenAt: integer("last_seen_at"),
  },
  (t) => [index("users_global_role_idx").on(t.globalRole)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    /** SHA-256 (hex) of the opaque cookie token; the token itself is never stored. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  globalRole: text("global_role", { enum: ["admin", "member", "guest"] }).notNull(),
  /** Initial project grants (M2), JSON validated with Zod. */
  projectGrants: text("project_grants"),
  note: text("note"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  usedBy: text("used_by").references(() => users.id, { onDelete: "set null" }),
  revokedAt: integer("revoked_at"),
});

export const passwordResets = sqliteTable(
  "password_resets",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Admin who created the link (null reserved for future self-service). */
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
  },
  (t) => [index("password_resets_user_idx").on(t.userId)],
);

/** "Forgot password?" requests waiting for an admin (decision log). One per user. */
export const passwordResetRequests = sqliteTable("password_reset_requests", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  requestedAt: integer("requested_at").notNull(),
  ip: text("ip"),
});

/**
 * Secrets a user keeps for themselves, e.g. an admin's Samply API key (SPEC §25.11). Sealed with
 * `sealSecret` (purpose per kind); only the last four characters are ever shown again.
 */
export const userSecrets = sqliteTable(
  "user_secrets",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["samply"] }).notNull(),
    secretEnc: text("secret_enc").notNull(),
    last4: text("last4").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);
