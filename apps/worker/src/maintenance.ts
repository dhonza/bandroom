import { uuidv7 } from "@bandroom/shared";
import {
  collectGarbageBlobs,
  expiredTrashIds,
  getSetting,
  purgeTrashItems,
  purgeClientRequests,
  purgeExpiredLinkSessions,
  purgeExpiredSessions,
  purgeExpiredUploadSessions,
  recordEvent,
  recoverExpiredJobs,
  setSetting,
  type Db,
  type StorageBackend,
} from "@bandroom/server-core";

export const MAINTENANCE_HOUR = 4;

/** Local date (server time) as YYYY-MM-DD. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Due once per day after 04:00 server time (SPEC §18.4). */
export function maintenanceDue(now: Date, lastRun: string | null): boolean {
  return now.getHours() >= MAINTENANCE_HOUR && lastRun !== localDate(now);
}

export interface MaintenanceResult {
  trashPurged: number;
  trashBytesFreed: number;
  blobsDeleted: number;
  bytesFreed: number;
  sessionsPurged: number;
  linkSessionsPurged: number;
  uploadSessionsPurged: number;
  clientRequestsPurged: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Purges Trash items deleted more than `trash.retentionDays` ago (SPEC §26.3), logged as the
 * system with `auto: true`: songs, tracks, versions, documents, and deleted projects (also those
 * deleted before projects were part of the Trash, by their `deletedAt`). Old auto-mix versions go
 * quietly. Runs before the blob GC, which deletes the released files once their grace period is
 * over.
 */
export function purgeExpiredTrash(db: Db, now: number): { purged: number; bytesFreed: number } {
  const cutoff = now - getSetting(db, "trash.retentionDays") * DAY_MS;
  const ids = expiredTrashIds(db, cutoff);
  const total =
    ids.songs.length +
    ids.tracks.length +
    ids.versions.length +
    ids.documents.length +
    ids.projects.length;
  if (total === 0) return { purged: 0, bytesFreed: 0 };
  const batchId = uuidv7(now);
  return db.transaction(() => {
    const r = purgeTrashItems(db, ids, now);
    const visible = r.purged.filter((p) => !p.system);
    for (const p of visible) {
      recordEvent(db, {
        action: `${p.kind}.purged`,
        actorType: "system",
        projectId: p.projectId,
        songId: p.songId,
        targetType: p.kind === "version" ? "trackVersion" : p.kind,
        targetId: p.id,
        details: { batchId, name: p.name, auto: true },
        ts: now,
      });
    }
    return { purged: visible.length, bytesFreed: r.bytesFreed };
  });
}

/**
 * Daily maintenance: Trash purge, blob GC, expired sessions, link visitor sessions and upload
 * sessions, old client request ids. Later milestones add retention, usage recompute and disk
 * checks here.
 */
export async function runMaintenance(
  db: Db,
  storage: StorageBackend,
  now: Date = new Date(),
): Promise<MaintenanceResult> {
  const t = now.getTime();
  recoverExpiredJobs(db, t);
  const trash = purgeExpiredTrash(db, t);
  const gc = await collectGarbageBlobs(db, storage, t);
  const sessionsPurged = purgeExpiredSessions(db, t);
  const linkSessionsPurged = purgeExpiredLinkSessions(db, t);
  const uploadSessionsPurged = purgeExpiredUploadSessions(db, t);
  const clientRequestsPurged = purgeClientRequests(db, t);
  setSetting(db, "maintenance.lastRun", localDate(now));
  return {
    trashPurged: trash.purged,
    trashBytesFreed: trash.bytesFreed,
    blobsDeleted: gc.deleted,
    bytesFreed: gc.bytes,
    sessionsPurged,
    linkSessionsPurged,
    uploadSessionsPurged,
    clientRequestsPurged,
  };
}

export function lastMaintenanceRun(db: Db): string | null {
  return getSetting(db, "maintenance.lastRun");
}

/** After a failed run, wait this long before trying again (the day's run stays due). */
export const MAINTENANCE_RETRY_MS = 60 * 60_000;

export interface MaintenanceLog {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface MaintenanceTickDeps {
  db: Db;
  storage: StorageBackend;
  log: MaintenanceLog;
  /** In-memory back-off: no attempt before this time (epoch ms). Updated on failure. */
  state: { retryAfter: number };
  /** Injectable for tests. */
  run?: typeof runMaintenance;
}

/**
 * One check of the worker loop: runs maintenance when due. Never throws, so a failing step
 * (e.g. a blob that cannot be deleted) cannot crash-loop the worker and stop all jobs; a failure
 * is logged and retried after `MAINTENANCE_RETRY_MS`.
 */
export async function maintenanceTick(
  deps: MaintenanceTickDeps,
  now: Date = new Date(),
): Promise<"idle" | "done" | "failed"> {
  if (now.getTime() < deps.state.retryAfter) return "idle";
  try {
    if (!maintenanceDue(now, lastMaintenanceRun(deps.db))) return "idle";
    const res = await (deps.run ?? runMaintenance)(deps.db, deps.storage, now);
    deps.log.info(res, "daily maintenance done");
    return "done";
  } catch (err) {
    deps.state.retryAfter = now.getTime() + MAINTENANCE_RETRY_MS;
    deps.log.error({ err, retryInMs: MAINTENANCE_RETRY_MS }, "daily maintenance failed");
    return "failed";
  }
}
