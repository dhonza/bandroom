import type { UserRow } from "../auth/users";
import type { Db } from "../db/connection";
import { getSetting } from "../settings/registry";
import { getUsage } from "./variants";

/** A file's size × 1.1 accounts for its derived variants (SPEC §15.1). */
export const QUOTA_OVERHEAD = 1.1;

/** The user's storage quota in bytes, or null when unlimited (SPEC §15.1). */
export function userQuotaBytes(db: Db, user: Pick<UserRow, "quotaBytes">): number | null {
  if (user.quotaBytes === -1) return null; // unlimited
  return user.quotaBytes ?? getSetting(db, "defaultQuotaBytes");
}

/**
 * Whether `bytes` more (× {@link QUOTA_OVERHEAD}) fit into the user's quota; when not, the bytes
 * still free (SPEC §15.1).
 */
export function quotaCheck(
  db: Db,
  user: Pick<UserRow, "id" | "quotaBytes">,
  bytes: number,
): { ok: true } | { ok: false; remainingBytes: number } {
  const quota = userQuotaBytes(db, user);
  const used = getUsage(db, user.id);
  if (quota === null || used + bytes * QUOTA_OVERHEAD <= quota) return { ok: true };
  return { ok: false, remainingBytes: Math.max(0, quota - used) };
}
