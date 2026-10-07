import { openSecret, PermanentJobError, type JobHandler } from "@bandroom/server-core";
import { z } from "zod";
import { SamplyApiError, SamplyClient } from "./api";
import { execute } from "./execute";
import { admitDownload, Cancelled, finish, ImportDiskFull } from "./runState";
import { scan } from "./scan";
import { getRun, SAMPLY_SECRET_PURPOSE } from "./store";

export { REPORT_MAX_FAILED_ITEMS, REPORT_MAX_ITEMS, Reporter } from "./report";
export { IMPORT_DISK_FACTOR, IMPORT_JOB_PRIORITY } from "./runState";
export { restorePreviousGrouping } from "./scan";
export { orderedPool, paletteFromHex } from "./util";

export const SAMPLY_JOB = "samply.import";

export const SamplyJobPayloadSchema = z.object({
  runId: z.string(),
  phase: z.enum(["scan", "run"]),
});
export type SamplyJobPayload = z.infer<typeof SamplyJobPayloadSchema>;

export interface SamplyJobDeps {
  appSecret: string;
  /** Override for tests and e2e (a local mock of the Samply API). */
  baseUrl?: string;
  fetch?: typeof fetch;
  minIntervalMs?: number;
  backoffMs?: number;
  /** Parallel downloads (SPEC §17.1: 2). */
  concurrency?: number;
  /** Largest file accepted (the server's `MAX_UPLOAD_BYTES`). */
  maxFileBytes?: number;
}

export function samplyImportHandler(
  deps: SamplyJobDeps,
): JobHandler<SamplyJobPayload, { status: string }> {
  return {
    type: SAMPLY_JOB,
    capability: SAMPLY_JOB,
    payloadSchema: SamplyJobPayloadSchema,
    async run(ctx, payload) {
      const run = getRun(ctx.db, payload.runId);
      if (!run) throw new PermanentJobError(`Import run ${payload.runId} not found`);
      if (run.status === "cancelled") return { status: "cancelled" };
      if (!run.secretEnc) throw new PermanentJobError("The run's API key is gone");
      const client = new SamplyClient({
        apiKey: openSecret(deps.appSecret, SAMPLY_SECRET_PURPOSE, run.secretEnc),
        baseUrl: deps.baseUrl,
        fetch: deps.fetch,
        minIntervalMs: deps.minIntervalMs,
        backoffMs: deps.backoffMs,
        signal: ctx.signal,
        downloadLimits: {
          maxBytes: deps.maxFileBytes,
          admit: (bytes) => admitDownload(ctx.tmpDir, bytes),
        },
      });
      try {
        if (payload.phase === "scan") await scan(ctx, run, client);
        else await execute(ctx, run, client, deps.concurrency ?? 2);
        return { status: getRun(ctx.db, run.id)?.status ?? "unknown" };
      } catch (err) {
        if (err instanceof Cancelled || ctx.signal.aborted) {
          finish(ctx, run.id, "cancelled", null);
          return { status: "cancelled" };
        }
        const message = err instanceof Error ? err.message : String(err);
        const permanent =
          (err instanceof SamplyApiError && err.unauthorized) || err instanceof ImportDiskFull;
        if (permanent || payload.phase === "scan") {
          finish(ctx, run.id, "failed", message.slice(0, 500));
          throw new PermanentJobError(message);
        }
        throw err; // retried; the import map makes a re-run idempotent
      }
    },
  };
}
