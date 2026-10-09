import {
  activeEditSession,
  buildEditBase,
  cancelEditSessionRow,
  createEditSessionRow,
  saveEditSessionRow,
  sessionState,
  takeOverEditSessionRow,
  toEditSession,
  type EditSessionRow,
} from "@bandroom/server-core";
import {
  applyOp,
  cancelEditSession,
  EDIT_SAVE_BODY_LIMIT,
  foldOps,
  getEditSession,
  MAX_EDIT_OPS,
  replay,
  saveEditSession,
  startEditSession,
  takeOverEditSession,
  validateOp,
  type EditOp,
  type EditState,
} from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";

/** `edit.session_saved` events: at most one per minute per session (SPEC §24.13). */
export const SAVE_EVENT_INTERVAL_MS = 60_000;

/**
 * Edit sessions (SPEC §24.7, §24.11): start, read, autosave, take over, cancel. The edit lock
 * itself is enforced centrally (`checkSongLock`); Apply and Bounce come with M18.
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
      const saved = db.transaction(() => {
        const next = saveEditSessionRow(db, row, { ...folded, options: body.options, logged }, now);
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
    if (row.status !== "open")
      throw new AppError("EDIT_SESSION_STATE", `The session is ${row.status}`);
    const cancelled = db.transaction(() => {
      const next = cancelEditSessionRow(db, row);
      if (next) {
        audit(db, request, {
          action: "edit.session_cancelled",
          ...event(next),
          details: { owner: row.ownerId, byOwner: row.ownerId === user.id, cursor: row.cursor },
        });
      }
      return next;
    });
    if (!cancelled) throw new AppError("EDIT_SESSION_STATE", "The session is no longer open");
    publish(cancelled, true);
    return { session: toEditSession(db, cancelled, cancelled.ownerId === user.id) };
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
