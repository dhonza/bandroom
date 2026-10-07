import {
  getUserById,
  projectImageHash,
  removeSongGrantRow,
  setSongGrantRow,
  setSongLockRow,
  songLockOf,
  softDeleteSong,
  songGrantRows,
  toSong,
  updateSongRow,
} from "@bandroom/server-core";
import {
  deleteSong,
  getSong,
  listSongGrants,
  lockSong,
  removeSongGrant,
  setSongGrant,
  unlockSong,
  updateSong,
} from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import type { SongScopeAccess } from "../http/scope";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";
import { notifyGranted } from "../notify";

export function registerSongRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const dto = (access: SongScopeAccess, row = access.song) =>
    toSong(
      row,
      access.project,
      access.role,
      projectImageHash(db, access.project),
      songLockOf(db, row),
    );
  // Open song pages refetch the song (lock state, title) when it changes.
  const published = (access: SongScopeAccess, data: Record<string, unknown>) => {
    ctx.hub.publish({
      type: "song.updated",
      projectId: access.project.id,
      songId: access.song.id,
      data,
    });
  };

  registerContract(app, getSong, ({ access }) => ({ song: dto(access) }));

  // Song lock (SPEC §25.12): idempotent; an event and SSE only on a real change.
  for (const [contract, locked] of [
    [lockSong, true],
    [unlockSong, false],
  ] as const) {
    registerContract(app, contract, ({ user, access }, request) => {
      const { row, changed } = setSongLockRow(db, access.song, user.id, locked);
      if (changed) {
        audit(db, request, {
          action: locked ? "song.locked" : "song.unlocked",
          projectId: access.project.id,
          songId: access.song.id,
          targetType: "song",
          targetId: access.song.id,
        });
        published(access, { locked });
      }
      return { song: dto(access, row) };
    });
  }

  registerContract(app, updateSong, ({ body, access }, request) => {
    const updated = updateSongRow(db, access.song, body);
    audit(db, request, {
      action: "song.updated",
      projectId: access.project.id,
      songId: access.song.id,
      targetType: "song",
      targetId: access.song.id,
      details: { changes: Object.keys(body) },
    });
    published(access, { changes: Object.keys(body) });
    return { song: dto(access, updated) };
  });

  registerContract(app, deleteSong, ({ user, access }, request) => {
    db.transaction(() => {
      softDeleteSong(db, access.song, Date.now(), user.id);
      audit(db, request, {
        action: "song.deleted",
        projectId: access.project.id,
        songId: access.song.id,
        targetType: "song",
        targetId: access.song.id,
        details: { title: access.song.title },
      });
    });
    // Project-scoped: the song is no longer visible, so a song-scoped event would reach nobody.
    ctx.hub.publish({
      type: "song.deleted",
      projectId: access.project.id,
      data: { songId: access.song.id },
    });
    return { ok: true as const };
  });

  registerContract(app, listSongGrants, ({ access }) => ({
    grants: songGrantRows(db, access.project.id, access.song.id),
  }));

  registerContract(app, setSongGrant, ({ params, body, user, access }, request) => {
    const target = getUserById(db, params.userId);
    if (!target) throw new AppError("NOT_FOUND", "User not found");
    const before = setSongGrantRow(db, access.song.id, target.id, body.role, user.id);
    audit(db, request, {
      action: "grant.changed",
      projectId: access.project.id,
      songId: access.song.id,
      targetType: "user",
      targetId: target.id,
      details: { scope: "song", before, after: body.role },
    });
    notifyGranted(ctx, {
      actor: user,
      granteeId: target.id,
      project: access.project,
      song: access.song,
      before,
      after: body.role,
    });
    return { ok: true as const };
  });

  registerContract(app, removeSongGrant, ({ params, access }, request) => {
    const before = removeSongGrantRow(db, access.song.id, params.userId);
    if (before !== null) {
      audit(db, request, {
        action: "grant.changed",
        projectId: access.project.id,
        songId: access.song.id,
        targetType: "user",
        targetId: params.userId,
        details: { scope: "song", before, after: null },
      });
    }
    return { ok: true as const };
  });
}
