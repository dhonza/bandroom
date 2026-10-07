import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects, songs } from "./content";
import { users } from "./identity";

// Public links (SPEC §3.5, §4.2, §4.4).

/**
 * Public share links. The 128-bit token is stored only as a SHA-256 hash for lookup, plus sealed
 * with the app secret (AES-GCM) so link managers can copy the URL again (decision log M10).
 */
export const publicLinks = sqliteTable(
  "public_links",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenSealed: text("token_sealed").notNull(),
    scopeType: text("scope_type", { enum: ["project", "song", "versions"] }).notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Set for `song` and `versions` links (versions always belong to one song). */
    songId: text("song_id").references(() => songs.id, { onDelete: "cascade" }),
    /** JSON array of track-version ids (`versions` links only). */
    versionIds: text("version_ids").notNull().default("[]"),
    versions: text("versions", { enum: ["current-only", "all"] }).notNull(),
    /** argon2id; null = no password. */
    passwordHash: text("password_hash"),
    expiresAt: integer("expires_at"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    revokedAt: integer("revoked_at"),
    allowDownload: integer("allow_download", { mode: "boolean" }).notNull().default(false),
    allowComments: integer("allow_comments", { mode: "boolean" }).notNull().default(false),
    showComments: integer("show_comments", { mode: "boolean" }).notNull().default(false),
    label: text("label").notNull().default(""),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("public_links_project_idx").on(t.projectId),
    index("public_links_song_idx").on(t.songId),
  ],
);

/** Anonymous visitor sessions of a public link (SPEC §4.4); the cookie is signed, see links. */
export const linkSessions = sqliteTable(
  "link_sessions",
  {
    id: text("id").primaryKey(),
    linkId: text("link_id")
      .notNull()
      .references(() => publicLinks.id, { onDelete: "cascade" }),
    /** Display name for anonymous comments, remembered for the session. */
    anonymousName: text("anonymous_name"),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    /** 12 h after creation (SPEC §3.5); set to now when the link's password changes. */
    expiresAt: integer("expires_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("link_sessions_link_idx").on(t.linkId, t.createdAt)],
);
