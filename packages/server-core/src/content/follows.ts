import type { FollowTarget } from "@bandroom/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { follows } from "../db/schema";

/** Follows a project or song (SPEC §16); returns whether it is new. */
export function followTarget(
  db: Db,
  userId: string,
  targetType: FollowTarget,
  targetId: string,
  now = Date.now(),
): boolean {
  return (
    db
      .insert(follows)
      .values({ userId, targetType, targetId, createdAt: now })
      .onConflictDoNothing()
      .run().changes > 0
  );
}

/** Returns whether a follow was removed. */
export function unfollowTarget(
  db: Db,
  userId: string,
  targetType: FollowTarget,
  targetId: string,
): boolean {
  return (
    db
      .delete(follows)
      .where(
        and(
          eq(follows.userId, userId),
          eq(follows.targetType, targetType),
          eq(follows.targetId, targetId),
        ),
      )
      .run().changes > 0
  );
}

export function isFollowing(
  db: Db,
  userId: string,
  targetType: FollowTarget,
  targetId: string,
): boolean {
  return (
    db
      .select({ u: follows.userId })
      .from(follows)
      .where(
        and(
          eq(follows.userId, userId),
          eq(follows.targetType, targetType),
          eq(follows.targetId, targetId),
        ),
      )
      .get() !== undefined
  );
}

export function followerIds(db: Db, targetType: FollowTarget, targetId: string): string[] {
  return db
    .select({ u: follows.userId })
    .from(follows)
    .where(and(eq(follows.targetType, targetType), eq(follows.targetId, targetId)))
    .all()
    .map((r) => r.u);
}
