import {
  listTrackVersions as listTrackVersionsRepo,
  listVisibleSongs,
  readySongIds,
  reorderTracks,
  reorderTrackVersions as reorderTrackVersionsRepo,
  setCurrentVersion,
  softDeleteTrackVersion,
  updateTrack as updateTrackRepo,
  updateTrackVersion as updateTrackVersionRepo,
  enqueueAudioIngest,
  getAsset,
  getTrackRow,
  getTrackVersionRow,
  listSongTracks,
  setAssetStatus,
  softDeleteTrack,
} from "@bandroom/server-core";
import {
  canActOn,
  deleteTrack,
  deleteTrackVersion as deleteTrackVersionContract,
  getProjectQueue,
  listSongTracks as listSongTracksContract,
  listTrackVersions,
  reorderSongTracks,
  reorderTrackVersions as reorderTrackVersionsContract,
  retryTrackVersion,
  setCurrentTrackVersion as setCurrentTrackVersionContract,
  updateTrack as updateTrackContract,
  updateTrackVersion as updateTrackVersionContract,
} from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";
import { downloadAllowed, type SongScopeAccess } from "../http/scope";
import { toTrack, toTrackVersion } from "./trackDto";

export function registerTrackRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  registerContract(app, listSongTracksContract, ({ access }) => {
    const allow = downloadAllowed(access);
    return { tracks: listSongTracks(db, access.song.id).map((t) => toTrack(t, allow)) };
  });

  registerContract(app, deleteTrack, ({ user, access }, request) => {
    const track = getTrackRow(db, access.targetId);
    if (!track) throw new AppError("NOT_FOUND", "Track not found");
    if (!canActOn(access.role, "delete", track.createdBy === user.id)) {
      throw new AppError("FORBIDDEN", "Only the uploader or an editor may delete this track");
    }
    db.transaction(() => {
      softDeleteTrack(db, track.id, Date.now(), user.id);
      audit(db, request, {
        action: "track.deleted",
        projectId: access.project.id,
        songId: access.song.id,
        targetType: "track",
        targetId: track.id,
        details: { name: track.name },
      });
    });
    ctx.hub.publish({
      type: "track.deleted",
      projectId: access.project.id,
      songId: access.song.id,
      data: { trackId: track.id },
    });
    return { ok: true as const };
  });

  registerContract(app, retryTrackVersion, ({ user, access }, request) => {
    const version = getTrackVersionRow(db, access.targetId);
    const asset = version && getAsset(db, version.assetId);
    if (!version || !asset) throw new AppError("NOT_FOUND", "Version not found");
    if (!canActOn(access.role, "edit", version.uploadedBy === user.id)) {
      throw new AppError("FORBIDDEN", "Only the uploader or an editor may retry");
    }
    if (asset.status !== "failed")
      throw new AppError("BAD_REQUEST", "Only failed versions can be retried");
    // Processing again would need the full-quality original, which is gone (SPEC §26.4).
    if (version.archivedAt !== null)
      throw new AppError("LOSSLESS_REMOVED", "Full-quality files were removed");
    db.transaction(() => {
      setAssetStatus(db, asset.id, "queued");
      enqueueAudioIngest(db, {
        assetId: asset.id,
        projectId: access.project.id,
        songId: access.song.id,
        trackVersionId: version.id,
        createdBy: user.id,
      });
      audit(db, request, {
        action: "version.retried",
        projectId: access.project.id,
        songId: access.song.id,
        targetType: "trackVersion",
        targetId: version.id,
      });
    });
    return { ok: true as const };
  });
}

export function registerVersionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const changed = (access: SongScopeAccess, type: string, data: Record<string, unknown>) => {
    ctx.hub.publish({ type, projectId: access.project.id, songId: access.song.id, data });
  };

  registerContract(app, listTrackVersions, ({ access }) => {
    const track = getTrackRow(db, access.targetId);
    if (!track) throw new AppError("NOT_FOUND", "Track not found");
    const allow = downloadAllowed(access);
    return {
      versions: listTrackVersionsRepo(db, track.id).map((v) => ({
        ...toTrackVersion(v, allow),
        isCurrent: v.version.id === track.currentVersionId,
      })),
    };
  });

  registerContract(app, updateTrackVersionContract, ({ body, user, access }, request) => {
    const v = getTrackVersionRow(db, access.targetId);
    const track = v && getTrackRow(db, v.trackId);
    if (!v || !track) throw new AppError("NOT_FOUND", "Version not found");
    const { gainDb, ...text } = body;
    const textChanges = Object.keys(text);
    // Label and notes belong to the version's uploader; gain is part of the track's sound, so it
    // follows the track's edit rule (SPEC §25.6).
    if (textChanges.length > 0 && !canActOn(access.role, "edit", v.uploadedBy === user.id))
      throw new AppError("FORBIDDEN", "Not allowed");
    if (gainDb !== undefined && !canActOn(access.role, "edit", track.createdBy === user.id))
      throw new AppError("FORBIDDEN", "Not allowed");
    const gainChanged = gainDb !== undefined && gainDb !== v.gainDb;
    db.transaction(() => {
      updateTrackVersionRepo(db, v.id, body);
      const scope = {
        projectId: access.project.id,
        songId: access.song.id,
        targetType: "trackVersion",
        targetId: v.id,
      };
      if (textChanges.length > 0)
        audit(db, request, {
          action: "version.updated",
          ...scope,
          details: { changes: textChanges },
        });
      if (gainChanged) {
        audit(db, request, {
          action: "version.gain_changed",
          ...scope,
          details: { trackId: track.id, before: v.gainDb, after: gainDb },
        });
      }
    });
    changed(access, "version.updated", { trackId: v.trackId, versionId: v.id });
    return { ok: true as const };
  });

  registerContract(app, deleteTrackVersionContract, ({ user, access }, request) => {
    const v = getTrackVersionRow(db, access.targetId);
    if (!v) throw new AppError("NOT_FOUND", "Version not found");
    if (!canActOn(access.role, "delete", v.uploadedBy === user.id))
      throw new AppError("FORBIDDEN", "Not allowed");
    db.transaction(() => {
      softDeleteTrackVersion(db, v.id, Date.now(), user.id);
      audit(db, request, {
        action: "version.deleted",
        projectId: access.project.id,
        songId: access.song.id,
        targetType: "trackVersion",
        targetId: v.id,
        details: { trackId: v.trackId, number: v.number },
      });
    });
    changed(access, "version.deleted", { trackId: v.trackId, versionId: v.id });
    return { ok: true as const };
  });

  registerContract(app, setCurrentTrackVersionContract, ({ body, access }, request) => {
    const track = getTrackRow(db, access.targetId);
    const v = getTrackVersionRow(db, body.versionId);
    if (!track || !v || v.trackId !== track.id)
      throw new AppError("NOT_FOUND", "Version not found");
    const before = track.currentVersionId;
    db.transaction(() => {
      setCurrentVersion(db, track.id, v.id);
      audit(db, request, {
        action: "version.set_current",
        projectId: access.project.id,
        songId: access.song.id,
        targetType: "track",
        targetId: track.id,
        details: { before, after: v.id, number: v.number },
      });
    });
    changed(access, "version.set_current", { trackId: track.id, versionId: v.id });
    return { ok: true as const };
  });

  registerContract(app, reorderTrackVersionsContract, ({ body, access }, request) => {
    db.transaction(() => {
      reorderTrackVersionsRepo(db, access.targetId, body.versionIds);
      audit(db, request, {
        action: "versions.reordered",
        projectId: access.project.id,
        songId: access.song.id,
        targetType: "track",
        targetId: access.targetId,
      });
    });
    changed(access, "version.updated", { trackId: access.targetId });
    return { ok: true as const };
  });

  registerContract(app, updateTrackContract, ({ body, user, access }, request) => {
    const track = getTrackRow(db, access.targetId);
    if (!track) throw new AppError("NOT_FOUND", "Track not found");
    if (!canActOn(access.role, "edit", track.createdBy === user.id))
      throw new AppError("FORBIDDEN", "Not allowed");
    db.transaction(() => {
      updateTrackRepo(db, track.id, body);
      audit(db, request, {
        action: "track.updated",
        projectId: access.project.id,
        songId: access.song.id,
        targetType: "track",
        targetId: track.id,
        details: { changes: Object.keys(body) },
      });
    });
    changed(access, "track.updated", { trackId: track.id });
    return { ok: true as const };
  });

  registerContract(app, reorderSongTracks, ({ body, access }, request) => {
    db.transaction(() => {
      reorderTracks(db, access.song.id, body.trackIds);
      audit(db, request, {
        action: "tracks.reordered",
        projectId: access.project.id,
        songId: access.song.id,
        targetType: "song",
        targetId: access.song.id,
      });
    });
    changed(access, "track.updated", {});
    return { ok: true as const };
  });

  registerContract(app, getProjectQueue, ({ user, access }) => {
    const songs = listVisibleSongs(db, user, access.project.id).map(({ song }) => song);
    const ready = readySongIds(
      db,
      songs.map((s) => s.id),
    );
    return {
      items: songs.map((song) => ({
        songId: song.id,
        title: song.title,
        subtitle: song.subtitle,
        ready: ready.has(song.id),
      })),
    };
  });
}
