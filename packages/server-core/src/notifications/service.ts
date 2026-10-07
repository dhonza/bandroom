import {
  NotificationPayloadSchema,
  NotificationTypeSchema,
  roleAtLeast,
  uuidv7,
  type Notification,
  type NotificationPayload,
  type NotificationType,
} from "@bandroom/shared";
import { and, count, desc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import { notifications, users } from "../db/schema";
import type { UserRow } from "../auth/users";
import { resolveProjectAccess, resolveSongAccess } from "../content/access";

/** Newest notifications kept per user (SPEC §19.6: nothing grows without a cap). */
export const NOTIFICATIONS_KEEP = 500;

export interface NotifyInput {
  type: NotificationType;
  userIds: Iterable<string>;
  /** Never notified about their own action. */
  actorId: string | null;
  payload: NotificationPayload;
  projectId?: string | null;
  songId?: string | null;
  /**
   * Project-scoped content that users with only the reduced view cannot see (project-level
   * documents, SPEC §3.3): recipients need at least `viewer` on the project itself.
   */
  projectViewersOnly?: boolean;
}

/**
 * The single place notifications are created (SPEC §16), so another channel (Web Push) can be
 * added here later. Recipients are deduplicated, the actor is skipped, disabled users are
 * skipped, and each recipient must still be able to see the song (or project). Returns the
 * created rows so the caller can publish them over SSE.
 */
export function createNotifications(
  db: Db,
  input: NotifyInput,
  now: number = Date.now(),
): { id: string; userId: string }[] {
  const ids = [...new Set(input.userIds)].filter((u) => u !== input.actorId);
  if (ids.length === 0) return [];
  const recipients = db
    .select()
    .from(users)
    .where(and(inArray(users.id, ids), isNull(users.disabledAt), isNull(users.deletedAt)))
    .all() as UserRow[];
  const allowed = recipients.filter((u) => {
    if (input.songId) {
      const a = resolveSongAccess(db, u, input.songId);
      return a !== undefined && roleAtLeast(a.role, "viewer");
    }
    if (input.projectId) {
      const a = resolveProjectAccess(db, u, input.projectId);
      if (input.projectViewersOnly) return a !== undefined && roleAtLeast(a.role, "viewer");
      return a !== undefined && a.visibility !== "hidden";
    }
    return true;
  });
  const payload = JSON.stringify(NotificationPayloadSchema.parse(input.payload));
  const created = allowed.map((u) => ({ id: uuidv7(now), userId: u.id }));
  if (created.length === 0) return [];
  db.transaction((tx) => {
    tx.insert(notifications)
      .values(
        created.map((c) => ({
          id: c.id,
          userId: c.userId,
          type: input.type,
          payload,
          projectId: input.projectId ?? null,
          songId: input.songId ?? null,
          createdAt: now,
        })),
      )
      .run();
    for (const c of created) pruneNotifications(tx as unknown as Db, c.userId);
  });
  return created;
}

function pruneNotifications(db: Db, userId: string): void {
  const keep = db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(NOTIFICATIONS_KEEP)
    .all()
    .map((r) => r.id);
  if (keep.length < NOTIFICATIONS_KEEP) return;
  db.delete(notifications)
    .where(and(eq(notifications.userId, userId), notInArray(notifications.id, keep)))
    .run();
}

/**
 * Whether the user has an unread notification of this type, optionally about one user (payload
 * `userId`) or one public link (payload `linkId`).
 */
export function hasUnreadNotification(
  db: Db,
  userId: string,
  type: NotificationType,
  aboutUserId: string | null = null,
  aboutKey: "userId" | "linkId" = "userId",
): boolean {
  return (
    db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.type, type),
          isNull(notifications.readAt),
          aboutUserId === null
            ? undefined
            : aboutKey === "linkId"
              ? sql`json_extract(${notifications.payload}, '$.linkId') = ${aboutUserId}`
              : sql`json_extract(${notifications.payload}, '$.userId') = ${aboutUserId}`,
        ),
      )
      .get() !== undefined
  );
}

type NotificationRow = typeof notifications.$inferSelect;

function toNotification(r: NotificationRow): Notification | null {
  const type = NotificationTypeSchema.safeParse(r.type);
  if (!type.success) return null;
  let raw: unknown = {};
  try {
    raw = JSON.parse(r.payload);
  } catch {
    // keep {}
  }
  const payload = NotificationPayloadSchema.safeParse(raw);
  return {
    id: r.id,
    type: type.data,
    payload: payload.success ? payload.data : {},
    createdAt: r.createdAt,
    readAt: r.readAt,
  };
}

/** Cursor = `createdAt:id` of the last notification of the previous page (newest first). */
export function listNotificationRows(
  db: Db,
  userId: string,
  opts: { cursor: { at: number; id: string } | null; limit: number; unreadOnly: boolean },
): { notifications: Notification[]; nextCursor: string | null } {
  const c = opts.cursor;
  const rows = db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        opts.unreadOnly ? isNull(notifications.readAt) : undefined,
        c
          ? or(
              lt(notifications.createdAt, c.at),
              and(eq(notifications.createdAt, c.at), lt(notifications.id, c.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(opts.limit + 1)
    .all();
  const page = rows.slice(0, opts.limit);
  const last = page.at(-1);
  return {
    notifications: page.map(toNotification).filter((n): n is Notification => n !== null),
    nextCursor: rows.length > opts.limit && last ? `${last.createdAt}:${last.id}` : null,
  };
}

export function unreadNotificationCount(db: Db, userId: string): number {
  return (
    db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .get()?.n ?? 0
  );
}

/** Marks some (or all) of the user's notifications read; returns how many changed. */
export function markNotificationsReadRows(
  db: Db,
  userId: string,
  ids: readonly string[] | "all",
  now = Date.now(),
): number {
  return db
    .update(notifications)
    .set({ readAt: now })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        ids === "all" ? undefined : inArray(notifications.id, [...ids]),
      ),
    )
    .run().changes;
}
