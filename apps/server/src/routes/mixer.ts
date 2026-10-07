import {
  createMixerSnapshot as createSnapshot,
  deleteMixerSnapshot as deleteSnapshot,
  getMixerState,
  listMixerSnapshots,
  MAX_MIXER_SNAPSHOTS,
  putMixerState,
} from "@bandroom/server-core";
import {
  createMixerSnapshot,
  deleteMixerSnapshot,
  getSongMixer,
  putSongMixer,
} from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";

/**
 * Personal mixer state and snapshots (SPEC §4.4, §11.3). Rows belong to the requesting user, so
 * queries are always filtered by `user.id`; access to the song itself is checked by the contract.
 */
export function registerMixerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  registerContract(app, getSongMixer, ({ user, access }) => ({
    state: getMixerState(db, user.id, access.song.id),
    snapshots: listMixerSnapshots(db, user.id, access.song.id),
  }));

  registerContract(app, putSongMixer, ({ user, access, body }) => {
    putMixerState(db, user.id, access.song.id, body.state);
    return { ok: true as const };
  });

  registerContract(app, createMixerSnapshot, ({ user, access, body }, request) => {
    const snapshot = createSnapshot(db, user.id, access.song.id, body.name, body.state);
    if (!snapshot) {
      throw new AppError("BAD_REQUEST", `At most ${MAX_MIXER_SNAPSHOTS} snapshots per song`);
    }
    audit(db, request, {
      action: "mixer.snapshot_saved",
      projectId: access.project.id,
      songId: access.song.id,
      targetType: "mixerSnapshot",
      targetId: snapshot.id,
      details: { name: snapshot.name },
    });
    return { snapshot };
  });

  registerContract(app, deleteMixerSnapshot, ({ user, access, params }, request) => {
    if (!deleteSnapshot(db, user.id, access.song.id, params.snapshotId)) {
      throw new AppError("NOT_FOUND", "Snapshot not found");
    }
    audit(db, request, {
      action: "mixer.snapshot_deleted",
      projectId: access.project.id,
      songId: access.song.id,
      targetType: "mixerSnapshot",
      targetId: params.snapshotId,
    });
    return { ok: true as const };
  });
}
