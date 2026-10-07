import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/connection";
import { passwordResetRequests, passwordResets } from "../db/schema";
import { DAY_MS } from "./invites";
import { generateToken, hashToken } from "./tokens";

export type PasswordResetRow = typeof passwordResets.$inferSelect;
export const RESET_LINK_TTL_MS = DAY_MS;

/**
 * Creates a one-time reset link (valid 24 h, SPEC §3.1). Earlier unused links for the same user
 * are invalidated so only the newest one works.
 */
export function createPasswordReset(
  db: Db,
  userId: string,
  createdBy: string | null,
  now: number = Date.now(),
): { token: string; reset: PasswordResetRow } {
  const token = generateToken();
  const reset = db.transaction((tx) => {
    tx.update(passwordResets)
      .set({ usedAt: now })
      .where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)))
      .run();
    return tx
      .insert(passwordResets)
      .values({
        tokenHash: hashToken(token),
        userId,
        createdBy,
        createdAt: now,
        expiresAt: now + RESET_LINK_TTL_MS,
      })
      .returning()
      .get();
  });
  return { token, reset };
}

export function findUsablePasswordReset(
  db: Db,
  token: string,
  now: number = Date.now(),
): PasswordResetRow | undefined {
  const r = db
    .select()
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, hashToken(token)))
    .get();
  if (!r || r.usedAt !== null || r.expiresAt <= now) return undefined;
  return r;
}

export function markPasswordResetUsed(db: Db, tokenHash: string, now: number = Date.now()): void {
  db.update(passwordResets)
    .set({ usedAt: now })
    .where(eq(passwordResets.tokenHash, tokenHash))
    .run();
}

/** Records (or refreshes) a "forgot password" request for admins. */
export function upsertResetRequest(
  db: Db,
  userId: string,
  ip: string | null,
  now: number = Date.now(),
): void {
  db.insert(passwordResetRequests)
    .values({ userId, requestedAt: now, ip })
    .onConflictDoUpdate({ target: passwordResetRequests.userId, set: { requestedAt: now, ip } })
    .run();
}

/** Removes a user's pending reset request; false if there was none. */
export function clearResetRequest(db: Db, userId: string): boolean {
  return (
    db.delete(passwordResetRequests).where(eq(passwordResetRequests.userId, userId)).run().changes >
    0
  );
}
