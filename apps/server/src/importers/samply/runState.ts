import { diskUsage, recordEvent, type JobContext } from "@bandroom/server-core";
import type { ImportReport } from "@bandroom/shared";
import { MIN_FREE_AFTER_UPLOAD } from "../../quota";
import { getRun, updateRun } from "./store";

/** Bulk-imported media waits behind interactive uploads (0) and cuts/bounces (−1). */
export const IMPORT_JOB_PRIORITY = -5;

/** Rough disk need per imported byte: original (or FLAC) + Opus variants + peaks. */
export const IMPORT_DISK_FACTOR = 1.4;

/** The data volume cannot take the next file; the run stops (retrying would not help). */
export class ImportDiskFull extends Error {
  constructor() {
    super("Not enough free disk space to continue the import");
    this.name = "ImportDiskFull";
  }
}

/** Refuses a download that would leave less than the upload reserve free (review M13). */
export async function admitDownload(dir: string, bytes: number | null): Promise<void> {
  const disk = await diskUsage(dir);
  if (disk.freeBytes - (bytes ?? 0) * IMPORT_DISK_FACTOR < MIN_FREE_AFTER_UPLOAD) {
    throw new ImportDiskFull();
  }
}

/** Stops the job between items when the run was cancelled from the API. */
export class Cancelled extends Error {}

export function emitRun(ctx: JobContext, runId: string, extra: Record<string, unknown> = {}): void {
  const row = getRun(ctx.db, runId);
  ctx.emit({
    type: "import.progress",
    data: { runId, status: row?.status, progress: row?.progress ?? 0, ...extra },
  });
}

export function checkCancelled(ctx: JobContext, runId: string): void {
  if (ctx.signal.aborted || getRun(ctx.db, runId)?.status === "cancelled") throw new Cancelled();
}

/** Final state: the API key is always dropped (SPEC §17.1 step 1). */
export function finish(
  ctx: JobContext,
  runId: string,
  status: "done" | "failed" | "cancelled" | "review",
  error: string | null,
  report?: ImportReport,
): void {
  const keepKey = status === "review";
  updateRun(ctx.db, runId, {
    status,
    error,
    ...(keepKey ? {} : { secretEnc: null, finishedAt: Date.now() }),
    ...(report ? { report } : {}),
  });
  const run = getRun(ctx.db, runId);
  if (!keepKey) {
    recordEvent(ctx.db, {
      action: status === "cancelled" ? "import.cancelled" : "import.finished",
      actorUserId: run?.createdBy ?? null,
      targetType: "import",
      targetId: runId,
      details: { status, error, counts: report?.counts ?? null },
    });
  }
  emitRun(ctx, runId);
}
