import {
  activeEditSession,
  buildEditBase,
  buildEditReview,
  cancelEditSessionWithRenders,
  createEditSessionRow,
  diskUsage,
  getBlob,
  getUsage,
  getVariant,
  hasPendingRenders,
  listEditRenders,
  planBytes,
  planEdit,
  planSources,
  purgeEditRenders,
  requestEditRenders,
  retryEditRenders,
  storedClientResponse,
  storeClientResponse,
  userQuotaBytes,
  resolveClipSource,
  type EditActor,
  type EditPlan,
  saveEditSessionRow,
  sessionState,
  takeOverEditSessionRow,
  toEditSession,
  type EditSessionRow,
} from "@bandroom/server-core";
import {
  applyEditSession,
  applyOp,
  bounceEditSession,
  cancelEditSession,
  EDIT_SAVE_BODY_LIMIT,
  foldOps,
  getEditSession,
  MAX_EDIT_OPS,
  replay,
  retryEditSession,
  reviewEditSession,
  saveEditSession,
  songEndFrame,
  startEditSession,
  takeOverEditSession,
  validateOp,
  type EditBounceRange,
  type EditOp,
  type EditOutcomeKind,
  type EditSongNaming,
  type EditState,
} from "@bandroom/shared";
import fs from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";
import { checkQuotaAndDisk, MIN_FREE_AFTER_UPLOAD } from "../quota";

/** `edit.session_saved` events: at most one per minute per session (SPEC §24.13). */
export const SAVE_EVENT_INTERVAL_MS = 60_000;

/**
 * Edit sessions (SPEC §24.7, §24.11): start, read, autosave, take over, cancel, and Apply,
 * Bounce, review and retry (SPEC §24.8–§24.9, §24.14). The edit lock itself is enforced
 * centrally (`checkSongLock`). Apply and Bounce render in the worker and commit there.
 */
export function registerEditSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  /** Song viewers follow the session (`edit.changed`); song DTOs refetch on lock changes. */
  const publish = (row: EditSessionRow, lockChanged: boolean) => {
    const dto = toEditSession(db, row, false);
    ctx.hub.publish({
      type: "edit.changed",
      projectId: row.projectId,
      songId: row.songId,
      data: {
        songId: row.songId,
        sessionId: row.id,
        status: row.status,
        owner: dto.owner,
        rev: row.rev,
      },
    });
    if (lockChanged) {
      ctx.hub.publish({
        type: "song.updated",
        projectId: row.projectId,
        songId: row.songId,
        data: { editing: row.status === "open" || row.status === "applying" },
      });
    }
  };
  const event = (row: EditSessionRow) => ({
    projectId: row.projectId,
    songId: row.songId,
    targetType: "editSession",
    targetId: row.id,
  });

  registerContract(app, startEditSession, ({ user, access }, request) => {
    const song = access.song;
    if (activeEditSession(db, song.id))
      throw new AppError("EDIT_SESSION_OPEN", "Another edit session is open");
    const built = buildEditBase(db, song.id);
    if (!built.ok) {
      throw built.reason === "processing"
        ? new AppError("PROCESSING_SOURCE", "A current version is still being processed")
        : new AppError("VALIDATION_FAILED", "The song has no audio to edit", { reason: "empty" });
    }
    let row: EditSessionRow;
    try {
      row = db.transaction(() => {
        const created = createEditSessionRow(db, {
          songId: song.id,
          projectId: access.project.id,
          userId: user.id,
          base: built.base,
        });
        audit(db, request, {
          action: "edit.session_started",
          ...event(created),
          details: { tracks: built.base.tracks.length },
        });
        return created;
      });
    } catch (err) {
      // The partial unique index: someone else started one in the meantime.
      if (activeEditSession(db, song.id))
        throw new AppError("EDIT_SESSION_OPEN", "Another edit session is open");
      throw err;
    }
    publish(row, true);
    return { session: toEditSession(db, row, true) };
  });

  registerContract(app, getEditSession, ({ user, access }) => {
    const row = activeEditSession(db, access.song.id);
    return { session: row ? toEditSession(db, row, row.ownerId === user.id) : null };
  });

  registerContract(
    app,
    saveEditSession,
    ({ body, user, access }, request) => {
      const row = access.session;
      if (row.status !== "open")
        throw new AppError("EDIT_SESSION_STATE", `The session is ${row.status}`);
      if (row.ownerId !== user.id)
        throw new AppError("NOT_SESSION_OWNER", "Someone else holds the session");
      if (body.rev !== row.rev) throw new AppError("EDIT_CONFLICT", "The session changed");
      const stored = sessionState(row);
      const ops = body.ops;
      checkNewOps(stored.base, stored.ops, ops);
      // Over the limit, the oldest applied ops go into the base (SPEC §24.7).
      const folded =
        ops.length > MAX_EDIT_OPS
          ? foldOps(stored.base, { ops, cursor: body.cursor }, MAX_EDIT_OPS)
          : { base: stored.base, ops, cursor: body.cursor };
      const now = Date.now();
      const logged = row.saveLoggedAt === null || now - row.saveLoggedAt >= SAVE_EVENT_INTERVAL_MS;
      // The renders of a failed Apply/Bounce no longer match once the edit changes.
      const stale =
        hasPendingRenders(db, row.id) &&
        (body.cursor !== row.cursor || JSON.stringify(body.ops) !== row.ops);
      const saved = db.transaction(() => {
        const next = saveEditSessionRow(db, row, { ...folded, options: body.options, logged }, now);
        if (next && stale) purgeEditRenders(db, row.id, now);
        if (next && logged) {
          audit(db, request, {
            action: "edit.session_saved",
            ...event(next),
            details: {
              ops: folded.ops.length,
              cursor: folded.cursor,
              rev: next.rev,
              foldedOps: folded.base.foldedOps,
            },
          });
        }
        return next;
      });
      if (!saved) throw new AppError("EDIT_CONFLICT", "The session changed");
      publish(saved, false);
      return { session: toEditSession(db, saved, true) };
    },
    { bodyLimit: EDIT_SAVE_BODY_LIMIT },
  );

  registerContract(app, takeOverEditSession, ({ user, access }, request) => {
    const row = access.session;
    if (row.status !== "open")
      throw new AppError("EDIT_SESSION_STATE", `The session is ${row.status}`);
    if (row.ownerId === user.id) return { session: toEditSession(db, row, true) };
    const taken = db.transaction(() => {
      const next = takeOverEditSessionRow(db, row, user.id);
      if (next) {
        audit(db, request, {
          action: "edit.session_taken_over",
          ...event(next),
          details: { from: row.ownerId, to: user.id },
        });
      }
      return next;
    });
    if (!taken) throw new AppError("EDIT_SESSION_STATE", "The session is no longer open");
    publish(taken, true);
    return { session: toEditSession(db, taken, true) };
  });

  registerContract(app, cancelEditSession, ({ user, access }, request) => {
    const row = access.session;
    if (row.status !== "open" && row.status !== "applying")
      throw new AppError("EDIT_SESSION_STATE", `The session is ${row.status}`);
    const cancelled = db.transaction(() => {
      const renders = listEditRenders(db, row.id).length;
      const next = cancelEditSessionWithRenders(db, row);
      if (next) {
        audit(db, request, {
          action: "edit.session_cancelled",
          ...event(next),
          details: {
            owner: row.ownerId,
            byOwner: row.ownerId === user.id,
            cursor: row.cursor,
            status: row.status,
            renders,
          },
        });
      }
      return next;
    });
    if (!cancelled) throw new AppError("EDIT_SESSION_STATE", "The session is no longer open");
    publish(cancelled, true);
    return { session: toEditSession(db, cancelled, cancelled.ownerId === user.id) };
  });

  // ——— Apply & Bounce (SPEC §24.8–§24.10) ———

  const ownOpen = (row: EditSessionRow, userId: string) => {
    if (row.status !== "open")
      throw new AppError("EDIT_SESSION_STATE", `The session is ${row.status}`);
    if (row.ownerId !== userId)
      throw new AppError("NOT_SESSION_OWNER", "Someone else holds the session");
  };
  const actorOf = (request: FastifyRequest, userId: string): EditActor => ({
    userId,
    sessionId: request.session?.id ?? null,
    ip: request.ip,
    userAgent: request.headers["user-agent"] ?? null,
    apiKeyId: request.apiKey?.id ?? null,
  });
  /** The peaks files of the session's sources (the base versions), for the peak estimate. */
  const loadPeaks = async (row: EditSessionRow): Promise<Map<string, Buffer>> => {
    const out = new Map<string, Buffer>();
    for (const t of sessionState(row).base.tracks) {
      const assetId = getTrackVersionAsset(t.versionId);
      const v = assetId && getVariant(db, assetId, "peaks");
      const blob = v && getBlob(db, v.blobHash);
      if (!assetId || !blob || out.has(assetId)) continue;
      try {
        out.set(assetId, await fs.readFile(await ctx.storage.localPath(blob.storageKey)));
      } catch {
        // no estimate for this source
      }
    }
    return out;
  };
  const getTrackVersionAsset = (versionId: string) => resolveClipSource(db, versionId)?.asset.id;

  registerContract(app, reviewEditSession, async ({ query, user, access }) => {
    const row = access.session;
    ownOpen(row, user.id);
    const quota = userQuotaBytes(db, user);
    const diskFreeBytes = await diskUsage(ctx.config.dataDir).then(
      (d) => d.freeBytes,
      () => null,
    );
    const peaks = await loadPeaks(row);
    const review = buildEditReview(db, row, query, {
      peaks: (assetId) => peaks.get(assetId) ?? null,
      quotaRemainingBytes: quota === null ? null : Math.max(0, quota - getUsage(db, user.id)),
      diskFreeBytes,
      minFreeBytes: MIN_FREE_AFTER_UPLOAD,
    });
    return { review };
  });

  /** Apply and Bounce: checks, quota and disk, then the guarded switch to `applying`. */
  const start = async (
    request: FastifyRequest,
    row: EditSessionRow,
    user: { id: string } & Parameters<typeof checkQuotaAndDisk>[1],
    body: {
      requestId: string;
      rev: number;
      kind: EditOutcomeKind;
      ranges?: EditBounceRange[];
      naming?: EditSongNaming;
      carryTempo?: boolean;
      keepEditing?: boolean;
    },
  ) => {
    const route = `edit:${row.id}`;
    // A replay answers with the session as it is now (SPEC §18.3).
    if (storedClientResponse(db, user.id, body.requestId, route) !== undefined)
      return { session: toEditSession(db, row, row.ownerId === user.id) };
    ownOpen(row, user.id);
    if (body.rev !== row.rev) throw new AppError("EDIT_CONFLICT", "The session changed");
    let plan: EditPlan;
    if (body.kind === "bounceSongs") {
      const ranges = body.ranges ?? [];
      const end = songEndFrame(planEdit(db, row, { kind: "apply" }).state);
      if (ranges.some((r) => r.endFrame > end))
        throw new AppError("VALIDATION_FAILED", "A range lies after the song end", {
          reason: "outsideSong",
        });
      plan = planEdit(db, row, {
        kind: "bounceSongs",
        ranges,
        ...(body.naming && { naming: body.naming }),
      });
    } else plan = planEdit(db, row, { kind: body.kind });
    if (plan.outputs.length === 0 && plan.emptied.length === 0)
      throw new AppError("VALIDATION_FAILED", "Nothing to render", { reason: "noChanges" });
    const sources = planSources(db, plan);
    if ([...sources.values()].some((s) => s === null))
      throw new AppError("VALIDATION_FAILED", "A source file is gone", { reason: "sourceMissing" });
    await checkQuotaAndDisk(ctx, user, planBytes(plan, sources));
    const next = requestEditRenders(db, row, {
      plan,
      rev: body.rev,
      actor: actorOf(request, user.id),
      ...(body.keepEditing !== undefined && { keepEditing: body.keepEditing }),
      ...(body.carryTempo !== undefined && { carryTempo: body.carryTempo }),
      ...(body.naming && { naming: body.naming }),
      ...(body.ranges && { ranges: body.ranges }),
    });
    if (!next) throw new AppError("EDIT_CONFLICT", "The session changed");
    storeClientResponse(db, user.id, body.requestId, route, { sessionId: row.id });
    publish(next, true);
    return { session: toEditSession(db, next, true) };
  };

  registerContract(app, applyEditSession, ({ body, user, access }, request) =>
    start(request, access.session, user, { ...body, kind: "apply" }),
  );

  registerContract(app, bounceEditSession, ({ body, user, access }, request) =>
    start(request, access.session, user, body),
  );

  registerContract(app, retryEditSession, async ({ user, access }, request) => {
    const row = access.session;
    ownOpen(row, user.id);
    const failed = listEditRenders(db, row.id).filter(
      (r) => r.status === "failed" || r.status === "skipped",
    );
    if (failed.length === 0) throw new AppError("EDIT_SESSION_STATE", "Nothing to retry");
    await checkQuotaAndDisk(
      ctx,
      user,
      failed.reduce((n, r) => n + r.lengthFrames * 2 * 3, 0),
    );
    const next = retryEditRenders(db, row, actorOf(request, user.id));
    if (!next) throw new AppError("EDIT_SESSION_STATE", "The session changed");
    publish(next, true);
    return { session: toEditSession(db, next, true) };
  });
}

/**
 * Validates a save on the server by replaying it with the shared model (SPEC §24.3): the ops the
 * session already has (the same op at the same place) are trusted, every new op must apply to
 * the state before it (`validateOp`), redo tail included. The op count is not checked here: the
 * save folds the oldest ops instead.
 */
function checkNewOps(
  base: Parameters<typeof replay>[0],
  stored: readonly EditOp[],
  ops: readonly EditOp[],
): void {
  let same = 0;
  while (
    same < ops.length &&
    same < stored.length &&
    JSON.stringify(ops[same]) === JSON.stringify(stored[same])
  )
    same++;
  let state: EditState = replay(base, ops, same);
  for (let i = same; i < ops.length; i++) {
    const op = ops[i] as EditOp;
    const reason = validateOp({ ...state, ops: 0 }, op);
    if (reason !== null)
      throw new AppError("VALIDATION_FAILED", `Op ${i} does not apply: ${reason}`, {
        index: i,
        reason,
      });
    state = applyOp(state, op);
  }
}
