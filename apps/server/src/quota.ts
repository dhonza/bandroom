import {
  activeAdminNames,
  diskUsage,
  quotaCheck,
  userQuotaBytes,
  type UserRow,
} from "@bandroom/server-core";
import type { AppContext } from "./context";
import { AppError } from "./http/errors";

/** Keep at least this much disk free after an upload (SPEC §5.1). */
export const MIN_FREE_AFTER_UPLOAD = 2 * 1024 ** 3;
export { QUOTA_OVERHEAD } from "@bandroom/server-core";

/** The user's storage quota in bytes, or null when unlimited (SPEC §15.1). */
export function effectiveQuota(ctx: Pick<AppContext, "db">, user: UserRow): number | null {
  return userQuotaBytes(ctx.db, user);
}

/**
 * Quota (size × 1.1) and free-disk checks for content created without tus (SPEC §5.1, §15.1).
 * `tempBytes` is scratch space the work needs on top (free disk only, e.g. a practice bounce's
 * stretched inputs, SPEC §30.7).
 */
export async function checkQuotaAndDisk(
  ctx: Pick<AppContext, "db" | "config">,
  user: UserRow,
  size: number,
  tempBytes = 0,
): Promise<void> {
  const quota = quotaCheck(ctx.db, user, size);
  if (!quota.ok) {
    throw new AppError("QUOTA_EXCEEDED", "Quota exceeded", {
      remainingBytes: quota.remainingBytes,
      admins: activeAdminNames(ctx.db).join(", "),
    });
  }
  const disk = await diskUsage(ctx.config.dataDir);
  if (disk.freeBytes - size - tempBytes < MIN_FREE_AFTER_UPLOAD) {
    throw new AppError("DISK_FULL", "Server storage is full");
  }
}
