import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import { uploadSessions, users } from "../db/schema";

export type UploadSessionRow = typeof uploadSessions.$inferSelect;

export function createUploadSession(db: Db, row: UploadSessionRow): void {
  db.insert(uploadSessions).values(row).run();
}

export function getUploadSession(db: Db, id: string): UploadSessionRow | undefined {
  return db.select().from(uploadSessions).where(eq(uploadSessions.id, id)).get();
}

export function completeUploadSession(db: Db, id: string, now: number = Date.now()): void {
  db.update(uploadSessions).set({ completedAt: now }).where(eq(uploadSessions.id, id)).run();
}

/** Forgets an upload the client terminated (tus DELETE) or that was refused at completion. */
export function deleteUploadSession(db: Db, id: string): void {
  db.delete(uploadSessions).where(eq(uploadSessions.id, id)).run();
}

/**
 * Declared bytes of a user's unfinished, unexpired uploads. Quota checks count them, so parallel
 * uploads cannot each pass against the same free space (SPEC §15.1).
 */
export function reservedUploadBytes(db: Db, userId: string, now: number = Date.now()): number {
  return (
    db
      .select({ bytes: sql<number | null>`sum(${uploadSessions.declaredSize})` })
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.userId, userId),
          isNull(uploadSessions.completedAt),
          gt(uploadSessions.expiresAt, now),
        ),
      )
      .get()?.bytes ?? 0
  );
}

/**
 * Maintenance: forget expired, unfinished upload sessions. Their files are deleted by the API
 * (`cleanUpExpiredUploads` in apps/server routes/uploads.ts), which owns the tus directory.
 */
export function purgeExpiredUploadSessions(db: Db, now: number = Date.now()): number {
  return db
    .delete(uploadSessions)
    .where(and(isNull(uploadSessions.completedAt), lt(uploadSessions.expiresAt, now)))
    .run().changes;
}

/** Display names of active admins (e.g. "ask X for more space", SPEC §15.1). */
export function activeAdminNames(db: Db): string[] {
  return db
    .select({ n: users.displayName })
    .from(users)
    .where(and(eq(users.globalRole, "admin"), isNull(users.disabledAt), isNull(users.deletedAt)))
    .all()
    .map((u) => u.n);
}

/** Ids of active admins (reset-request notifications). */
export function activeAdminIds(db: Db): string[] {
  return db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.globalRole, "admin"), isNull(users.disabledAt), isNull(users.deletedAt)))
    .all()
    .map((u) => u.id);
}
