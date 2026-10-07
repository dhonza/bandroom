import {
  followTarget,
  isFollowing,
  listNotificationRows,
  markNotificationsReadRows,
  parseTimeCursor,
  unfollowTarget,
  unreadNotificationCount,
} from "@bandroom/server-core";
import {
  getProjectFollow,
  getSongFollow,
  getUnreadNotificationCount,
  listNotifications,
  markNotificationsRead,
  setProjectFollow,
  setSongFollow,
  NOTIFICATIONS_PAGE_MAX,
  type FollowTarget,
} from "@bandroom/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";

/**
 * In-app notifications (SPEC §16; no email) and follows. Reading notifications is not an
 * activity event (like song visits); following and unfollowing are.
 */
export function registerNotificationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  registerContract(app, listNotifications, ({ query, user }) => {
    const cursor = parseTimeCursor(query.cursor);
    if (query.cursor && !cursor) throw new AppError("BAD_REQUEST", "Invalid cursor");
    return {
      ...listNotificationRows(db, user.id, {
        cursor,
        limit: query.limit ?? NOTIFICATIONS_PAGE_MAX,
        unreadOnly: query.unread === "true",
      }),
      unreadCount: unreadNotificationCount(db, user.id),
    };
  });

  registerContract(app, getUnreadNotificationCount, ({ user }) => ({
    count: unreadNotificationCount(db, user.id),
  }));

  registerContract(app, markNotificationsRead, ({ body, user }) => {
    const changed = markNotificationsReadRows(db, user.id, "all" in body ? "all" : body.ids);
    if (changed > 0) {
      ctx.hub.publish({ type: "notification", userId: user.id, data: { read: true } });
    }
    return { ok: true as const };
  });

  const setFollow = (
    request: FastifyRequest,
    userId: string,
    type: FollowTarget,
    ids: { projectId: string; songId?: string },
    following: boolean,
  ) => {
    const targetId = type === "song" && ids.songId ? ids.songId : ids.projectId;
    const changed = following
      ? followTarget(db, userId, type, targetId)
      : unfollowTarget(db, userId, type, targetId);
    if (changed) {
      audit(db, request, {
        action: following ? "follow.added" : "follow.removed",
        projectId: ids.projectId,
        songId: ids.songId ?? null,
        targetType: type,
        targetId,
      });
    }
    return { following };
  };

  registerContract(app, getSongFollow, ({ access, user }) => ({
    following: isFollowing(db, user.id, "song", access.song.id),
  }));
  registerContract(app, setSongFollow, ({ access, body, user }, request) =>
    setFollow(
      request,
      user.id,
      "song",
      { projectId: access.project.id, songId: access.song.id },
      body.following,
    ),
  );
  registerContract(app, getProjectFollow, ({ access, user }) => ({
    following: isFollowing(db, user.id, "project", access.project.id),
  }));
  registerContract(app, setProjectFollow, ({ access, body, user }, request) =>
    setFollow(request, user.id, "project", { projectId: access.project.id }, body.following),
  );
}
