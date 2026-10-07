import { z } from "zod";
import { NotificationSchema } from "../notifications";
import { OkSchema } from "./auth";
import { defineContract } from "./contract";

const IdParams = z.object({ id: z.string().min(1).max(64) });

export const NOTIFICATIONS_PAGE_MAX = 100;

/** The caller's notifications, newest first (SPEC §16, cursor pagination SPEC §18.3). */
export const listNotifications = defineContract({
  method: "GET",
  path: "/me/notifications",
  query: z.object({
    cursor: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(NOTIFICATIONS_PAGE_MAX).optional(),
    unread: z.enum(["true", "false"]).optional(),
  }),
  response: z.object({
    notifications: z.array(NotificationSchema),
    nextCursor: z.string().nullable(),
    unreadCount: z.number().int(),
  }),
  errors: ["BAD_REQUEST"],
  auth: { user: true },
});

/** Badge count for the bell (SPEC §11.2). */
export const getUnreadNotificationCount = defineContract({
  method: "GET",
  path: "/me/notifications/unread-count",
  response: z.object({ count: z.number().int() }),
  auth: { user: true },
});

/** Marks the given notifications (or all) as read. */
export const markNotificationsRead = defineContract({
  method: "POST",
  path: "/me/notifications/read",
  body: z.union([
    z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(NOTIFICATIONS_PAGE_MAX) }),
    z.object({ all: z.literal(true) }),
  ]),
  response: OkSchema,
  auth: { user: true },
});

const FollowSchema = z.object({ following: z.boolean() });

/** Follows (SPEC §16): new versions in followed songs, new songs in followed projects. */
export const getSongFollow = defineContract({
  method: "GET",
  path: "/songs/:id/follow",
  params: IdParams,
  response: FollowSchema,
  auth: { capability: "view", scope: "song" },
});

export const setSongFollow = defineContract({
  method: "PUT",
  path: "/songs/:id/follow",
  params: IdParams,
  body: FollowSchema,
  response: FollowSchema,
  auth: { capability: "view", scope: "song" },
});

export const getProjectFollow = defineContract({
  method: "GET",
  path: "/projects/:id/follow",
  params: IdParams,
  response: FollowSchema,
  auth: { capability: "view", scope: "project" },
});

export const setProjectFollow = defineContract({
  method: "PUT",
  path: "/projects/:id/follow",
  params: IdParams,
  body: FollowSchema,
  response: FollowSchema,
  auth: { capability: "view", scope: "project" },
});
