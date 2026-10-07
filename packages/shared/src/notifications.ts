import { z } from "zod";
import { ContentRoleSchema } from "./permissions/content";

/** Notifications (SPEC §16, in-app only). */

export const NOTIFICATION_TYPES = [
  "mention",
  "reply",
  "comment_on_upload",
  "new_version",
  "new_song",
  "granted",
  "quota_warning",
  "reset_request",
  "new_document",
  /** A wrong password was entered on one of my public links (one unread per link). */
  "link_password_failed",
  /** A visitor commented through one of my public links. */
  "link_comment",
] as const;
export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

/** Everything a notification needs to render and deep-link without further requests. */
export const NotificationPayloadSchema = z.object({
  actorName: z.string().nullable().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  songId: z.string().optional(),
  songTitle: z.string().optional(),
  commentId: z.string().optional(),
  startSec: z.number().nullable().optional(),
  excerpt: z.string().optional(),
  trackName: z.string().optional(),
  versionNumber: z.number().optional(),
  role: ContentRoleSchema.optional(),
  userId: z.string().optional(),
  username: z.string().optional(),
  percent: z.number().optional(),
  documentId: z.string().optional(),
  documentTitle: z.string().optional(),
  linkId: z.string().optional(),
  linkLabel: z.string().optional(),
});
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

export const NotificationSchema = z.object({
  id: z.string(),
  type: NotificationTypeSchema,
  payload: NotificationPayloadSchema,
  createdAt: z.number(),
  readAt: z.number().nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;

/** Excerpt of a comment body for notifications (plain text, ≤ 140 chars). */
export function commentExcerpt(body: string, max = 140): string {
  const plain = body
    .replace(/[*_`~>#]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

export const FOLLOW_TARGETS = ["project", "song"] as const;
export type FollowTarget = (typeof FOLLOW_TARGETS)[number];
