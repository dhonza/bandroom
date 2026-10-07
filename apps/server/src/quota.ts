import {
  activeAdminNames,
  diskUsage,
  getSetting,
  getUsage,
  type UserRow,
} from "@bandroom/server-core";
import type { AppContext } from "./context";
import { AppError } from "./http/errors";

/** Keep at least this much disk free after an upload (SPEC §5.1). */
export const MIN_FREE_AFTER_UPLOAD = 2 * 1024 ** 3;
/** Declared size × 1.1 accounts for derived variants (SPEC §15.1). */
export const QUOTA_OVERHEAD = 1.1;

/** The user's storage quota in bytes, or null when unlimited (SPEC §15.1). */
export function effectiveQuota(ctx: Pick<AppContext, "db">, user: UserRow): number | null {
  if (user.quotaBytes === -1) return null; // unlimited
  return user.quotaBytes ?? getSetting(ctx.db, "defaultQuotaBytes");
}

/** Quota (size × 1.1) and free-disk checks for content created without tus (SPEC §5.1, §15.1). */
export async function checkQuotaAndDisk(
  ctx: Pick<AppContext, "db" | "config">,
  user: UserRow,
  size: number,
): Promise<void> {
  const quota = effectiveQuota(ctx, user);
  const used = getUsage(ctx.db, user.id);
  if (quota !== null && used + size * QUOTA_OVERHEAD > quota) {
    throw new AppError("QUOTA_EXCEEDED", "Quota exceeded", {
      remainingBytes: Math.max(0, quota - used),
      admins: activeAdminNames(ctx.db).join(", "),
    });
  }
  const disk = await diskUsage(ctx.config.dataDir);
  if (disk.freeBytes - size < MIN_FREE_AFTER_UPLOAD) {
    throw new AppError("DISK_FULL", "Server storage is full");
  }
}
