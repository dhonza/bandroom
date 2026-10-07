import {
  cancelJob,
  deleteUserSecret,
  diskUsage,
  enqueueJob,
  getUsage,
  getUserSecretInfo,
  openSecret,
  openUserSecret,
  saveUserSecret,
  schema,
  sealSecret,
  type UserSecretInfo,
} from "@bandroom/server-core";
import {
  cancelImport,
  deleteMySamplyKey,
  getMySamplyKey,
  saveMySamplyKey,
  getImportRun,
  listImportProjects,
  listImportRuns,
  samplyConnect,
  scanImport,
  startImport,
  updateImportMapping,
  type SamplyProjectSummary,
} from "@bandroom/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";
import { SamplyApiError, SamplyClient, type SamplyProject } from "../importers/samply/api";
import { IMPORT_DISK_FACTOR, SAMPLY_JOB } from "../importers/samply/job";
import { computeTotals, validateMapping } from "../importers/samply/mapping";
import {
  createRun,
  getRun,
  listRuns,
  liveLocal,
  runMapping,
  SAMPLY_SECRET_PURPOSE,
  toImportRun,
  updateRun,
  type ImportRunRow,
} from "../importers/samply/store";
import { effectiveQuota, MIN_FREE_AFTER_UPLOAD, QUOTA_OVERHEAD } from "../quota";

export function registerImportRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const client = (apiKey: string) =>
    new SamplyClient({
      apiKey,
      baseUrl: ctx.samply.baseUrl,
      fetch: ctx.samply.fetch,
      minIntervalMs: ctx.samply.minIntervalMs,
      backoffMs: ctx.samply.backoffMs,
      maxRetries: 2,
    });

  const runOr404 = (id: string): ImportRunRow => {
    const run = getRun(db, id);
    if (!run) throw new AppError("NOT_FOUND", "Import run not found");
    return run;
  };
  const keyOf = (run: ImportRunRow): string => {
    if (!run.secretEnc) throw new AppError("IMPORT_KEY_GONE", "Connect to Samply again");
    return openSecret(ctx.config.appSecret, SAMPLY_SECRET_PURPOSE, run.secretEnc);
  };
  const samplyCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SamplyApiError && err.unauthorized)
        throw new AppError("SAMPLY_AUTH_FAILED", "Samply rejected the API key");
      throw new AppError("SAMPLY_UNAVAILABLE", "Samply is not reachable right now");
    }
  };
  const summaries = (projects: SamplyProject[]): SamplyProjectSummary[] =>
    projects.map((p) => {
      const local = liveLocal(db, "project", p.id, "project");
      return {
        samplyId: p.id,
        name: p.name,
        sizeBytes: p.size ?? null,
        timeModified: p.timeModified ?? null,
        existingProjectId: local,
      };
    });
  const enqueue = (run: ImportRunRow, phase: "scan" | "run", userId: string) =>
    enqueueJob(db, {
      type: SAMPLY_JOB,
      capability: SAMPLY_JOB,
      payload: { runId: run.id, phase },
      dedupeKey: `samply:${run.id}`,
      maxAttempts: phase === "scan" ? 1 : 3,
      createdBy: userId,
    });

  const savedInfo = (info: UserSecretInfo | null) =>
    info
      ? { saved: true, last4: info.last4, updatedAt: info.updatedAt }
      : { saved: false, last4: null, updatedAt: null };

  // The admin's own saved Samply key (SPEC §25.11): shown only as its last four characters.
  registerContract(app, getMySamplyKey, ({ user }) =>
    savedInfo(getUserSecretInfo(db, user.id, "samply")),
  );

  registerContract(app, saveMySamplyKey, ({ body, user }, request) =>
    db.transaction(() => {
      const replaced = getUserSecretInfo(db, user.id, "samply") !== null;
      const info = saveUserSecret(db, ctx.config.appSecret, user.id, "samply", body.apiKey);
      audit(db, request, {
        action: "secret.saved",
        targetType: "user",
        targetId: user.id,
        details: { kind: "samply", replaced },
      });
      return savedInfo(info);
    }),
  );

  registerContract(app, deleteMySamplyKey, ({ user }, request) =>
    db.transaction(() => {
      if (deleteUserSecret(db, user.id, "samply")) {
        audit(db, request, {
          action: "secret.deleted",
          targetType: "user",
          targetId: user.id,
          details: { kind: "samply" },
        });
      }
      return savedInfo(null);
    }),
  );

  registerContract(app, samplyConnect, async ({ body, user }, request) => {
    let apiKey: string;
    if ("apiKey" in body) apiKey = body.apiKey;
    else {
      const saved = openUserSecret(db, ctx.config.appSecret, user.id, "samply");
      if (saved === null) throw new AppError("SAMPLY_KEY_NOT_SAVED", "No saved Samply key");
      apiKey = saved;
    }
    const projects = await samplyCall(() => client(apiKey).listProjects());
    const run = createRun(db, {
      secretEnc: sealSecret(ctx.config.appSecret, SAMPLY_SECRET_PURPOSE, apiKey),
      createdBy: user.id,
    });
    audit(db, request, {
      action: "import.connected",
      targetType: "import",
      targetId: run.id,
      details: { source: "samply", projects: projects.length, savedKey: !("apiKey" in body) },
    });
    return { run: toImportRun(run), projects: summaries(projects) };
  });

  registerContract(app, listImportRuns, () => ({ runs: listRuns(db).map(toImportRun) }));

  registerContract(app, getImportRun, ({ params }) => ({
    run: toImportRun(runOr404(params.id)),
  }));

  registerContract(app, listImportProjects, async ({ params }) => {
    const run = runOr404(params.id);
    const key = keyOf(run);
    return { projects: summaries(await samplyCall(() => client(key).listProjects())) };
  });

  registerContract(app, scanImport, ({ params, body, user }, request) => {
    const run = runOr404(params.id);
    if (!["connected", "review", "failed"].includes(run.status))
      throw new AppError("IMPORT_STATE", `Cannot scan while ${run.status}`);
    keyOf(run);
    db.transaction(() => {
      const updated = updateRun(db, run.id, {
        selection: body.projectIds,
        status: "scanning",
        progress: 0,
        error: null,
        mapping: null,
        report: null,
      });
      enqueue(updated, "scan", user.id);
      audit(db, request, {
        action: "import.scanned",
        targetType: "import",
        targetId: run.id,
        details: { projects: body.projectIds.length },
      });
    });
    return { ok: true as const };
  });

  registerContract(app, updateImportMapping, ({ params, body }, request) => {
    const run = runOr404(params.id);
    if (run.status !== "review")
      throw new AppError("IMPORT_STATE", `Cannot edit the mapping while ${run.status}`);
    const errors = validateMapping(body.mapping);
    if (errors.length)
      throw new AppError("VALIDATION_FAILED", "The mapping has problems", {
        problems: errors.join("\n"),
      });
    const updated = db.transaction(() => {
      const row = updateRun(db, run.id, { mapping: body.mapping });
      audit(db, request, {
        action: "import.mapping_changed",
        targetType: "import",
        targetId: run.id,
        details: { projects: body.mapping.projects.length },
      });
      return row;
    });
    return { run: toImportRun(updated) };
  });

  registerContract(app, startImport, async ({ params, body, user }, request) => {
    const run = runOr404(params.id);
    if (run.status !== "review")
      throw new AppError("IMPORT_STATE", `Cannot start while ${run.status}`);
    keyOf(run);
    const mapping = runMapping(run);
    if (!mapping) throw new AppError("IMPORT_STATE", "Scan first");
    const errors = validateMapping(mapping);
    if (errors.length)
      throw new AppError("VALIDATION_FAILED", "The mapping has problems", {
        problems: errors.join("\n"),
      });
    if (!body.dryRun) {
      const bytes = computeTotals(mapping).bytes;
      const quota = effectiveQuota(ctx, user);
      const used = getUsage(db, user.id);
      if (quota !== null && used + bytes * QUOTA_OVERHEAD > quota)
        throw new AppError("QUOTA_EXCEEDED", "Quota exceeded", {
          remainingBytes: Math.max(0, quota - used),
        });
      const disk = await diskUsage(ctx.config.dataDir);
      if (disk.freeBytes - bytes * IMPORT_DISK_FACTOR < MIN_FREE_AFTER_UPLOAD)
        throw new AppError("DISK_FULL", "Not enough free disk space for this import");
    }
    const updated = updateRun(db, run.id, {
      dryRun: body.dryRun,
      status: "running",
      progress: 0,
      error: null,
      report: null,
    });
    enqueue(updated, "run", user.id);
    audit(db, request, {
      action: "import.started",
      targetType: "import",
      targetId: run.id,
      details: { dryRun: body.dryRun, queued: true },
    });
    return { ok: true as const };
  });

  registerContract(app, cancelImport, ({ params }, request) => {
    const run = runOr404(params.id);
    if (["done", "failed", "cancelled"].includes(run.status) && !run.secretEnc)
      return { ok: true as const };
    const active = db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.dedupeKey, `samply:${run.id}`),
          inArray(schema.jobs.status, ["queued", "running"]),
        ),
      )
      .all();
    for (const j of active) cancelJob(db, j.id);
    updateRun(db, run.id, { status: "cancelled", secretEnc: null, finishedAt: Date.now() });
    audit(db, request, { action: "import.cancelled", targetType: "import", targetId: run.id });
    ctx.hub.publish({ type: "import.progress", data: { runId: run.id, status: "cancelled" } });
    return { ok: true as const };
  });
}
