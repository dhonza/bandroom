import fs from "node:fs/promises";
import type { Upload } from "@tus/server";
import {
  addTrackVersion,
  createOriginalAsset,
  createSongRow,
  createTrackWithVersion,
  enqueueAudioIngest,
  enqueueLogoIngest,
  enqueueProjectImageIngest,
  getTrackRow,
  getUsage,
  sha256File,
  storeFile,
  completeUploadSession,
  deleteUploadSession,
  getUploadSession,
  recordEvent,
  setSetting,
  updateProjectRow,
  type SongRow,
  type UserRow,
} from "@bandroom/server-core";
import type { UploadResult, UploadTarget } from "@bandroom/shared";
import type { AppContext } from "../../context";
import { AppError } from "../../http/errors";
import { notifyNewSong, notifyQuotaFor, notifyVersionUploaded } from "../../notify";
import { effectiveQuota, QUOTA_OVERHEAD } from "../../quota";
import { finishDocumentUpload } from "./finishDocument";
import {
  adminNames,
  apiKeyIdOf,
  authorizeTarget,
  ipOf,
  parseStoredTarget,
  tusError,
  userOf,
} from "./tusSupport";

export async function finishUpload(
  ctx: AppContext,
  req: Request,
  upload: Upload,
): Promise<UploadResult> {
  const { db } = ctx;
  const user = userOf(ctx, req);
  const session = getUploadSession(db, upload.id);
  if (!session || session.userId !== user.id) throw tusError("NOT_FOUND", 404, "Upload not found");
  const file = upload.storage?.path;
  // An upload that cannot be finished frees its quota reservation and its files. Its blob, if
  // already stored, is unreferenced and freed by GC.
  const discard = async () => {
    deleteUploadSession(db, upload.id);
    if (file) {
      await fs.rm(file, { force: true });
      await fs.rm(`${file}.json`, { force: true });
    }
  };
  const target = parseStoredTarget(session.target);
  if (!target) {
    await discard();
    throw tusError("VALIDATION_FAILED", 400, "Invalid upload target");
  }
  const access = authorizeTarget(ctx, user, target); // permissions may have changed meanwhile

  if (!file) throw tusError("INTERNAL", 500, "Upload file missing");
  // Re-checked with the real size: the quota or the usage may have changed since creation.
  const quota = effectiveQuota(ctx, user);
  const { size } = await fs.stat(file);
  const used = getUsage(db, user.id);
  if (quota !== null && used + size * QUOTA_OVERHEAD > quota) {
    await discard();
    throw tusError("QUOTA_EXCEEDED", 413, "Quota exceeded", {
      remainingBytes: Math.max(0, quota - used),
      admins: adminNames(ctx),
    });
  }
  const hash = await sha256File(file);
  const blob = await storeFile(db, ctx.storage, file, hash);
  await fs.rm(`${file}.json`, { force: true }); // tus FileStore metadata

  if (target.type === "instanceLogo") {
    return finishLogoUpload(ctx, req, user, {
      uploadId: upload.id,
      filename: session.filename,
      blob,
      hash,
      discard,
    });
  }
  if (access === null) throw new AppError("INTERNAL", "Unexpected scope");
  if (target.type === "newDocument" || target.type === "documentVersion") {
    return finishDocumentUpload(ctx, req, user, access, {
      target,
      uploadId: upload.id,
      filename: session.filename,
      blob,
      discard,
    });
  }

  const kind = target.type === "projectImage" ? "image" : "audio";
  // Lossy on upload and the Opus preset (SPEC §28.2), kept on the asset for retries.
  const options = target.type === "projectImage" ? undefined : target.options;
  const now = Date.now();
  const commit = (): CommitResult => {
    const asset = createOriginalAsset(
      db,
      {
        kind,
        originalFilename: session.filename,
        sizeBytes: blob.sizeBytes,
        originalHash: hash,
        uploadedBy: user.id,
        ingestOptions: options ?? null,
      },
      blob,
      now,
    );
    completeUploadSession(db, upload.id, now);

    if (target.type === "projectImage") {
      updateProjectRow(db, target.projectId, { imageAssetId: asset.id }, now);
      enqueueProjectImageIngest(db, {
        assetId: asset.id,
        projectId: target.projectId,
        createdBy: user.id,
      });
      return {
        assetId: asset.id,
        trackId: null,
        trackVersionId: null,
        projectId: target.projectId,
        songId: null,
        newSong: null,
      };
    }
    // A recorded take keeps its source and timeline position (SPEC §9).
    const version = {
      assetId: asset.id,
      uploadedBy: user.id,
      ...(target.source && { source: target.source }),
      ...(target.offsetSamples !== undefined && { offsetSamples: target.offsetSamples }),
      ...(target.gainDb !== undefined && { gainDb: target.gainDb }),
    };
    let newSong: SongRow | null = null;
    let songId: string;
    let trackId: string;
    let versionId: string;
    if (target.type === "newSong") {
      newSong = createSongRow(
        db,
        { projectId: access.project.id, title: target.title, createdBy: user.id },
        now,
      );
      const created = createTrackWithVersion(
        db,
        { songId: newSong.id, name: target.trackName, ...version },
        now,
      );
      songId = newSong.id;
      trackId = created.track.id;
      versionId = created.version.id;
    } else if (target.type === "newTrack") {
      if (access.scope !== "song") throw new AppError("INTERNAL", "Unexpected scope");
      const created = createTrackWithVersion(
        db,
        { songId: target.songId, name: target.name, ...version },
        now,
      );
      songId = access.song.id;
      trackId = created.track.id;
      versionId = created.version.id;
    } else {
      if (access.scope !== "track") throw new AppError("INTERNAL", "Unexpected scope");
      const track = getTrackRow(db, target.trackId);
      if (!track) throw new AppError("NOT_FOUND", "Track not found");
      songId = access.song.id;
      trackId = track.id;
      versionId = addTrackVersion(db, { trackId: track.id, ...version }, now).id;
    }
    enqueueAudioIngest(db, {
      assetId: asset.id,
      projectId: access.project.id,
      songId,
      trackVersionId: versionId,
      createdBy: user.id,
    });
    return {
      assetId: asset.id,
      trackId,
      trackVersionId: versionId,
      projectId: access.project.id,
      songId,
      newSong,
    };
  };
  // The event is part of the change (review M14).
  let result: CommitResult;
  try {
    result = db.transaction(() => {
      const r = commit();
      recordUploadEvent(ctx, req, user, r, target);
      return r;
    });
  } catch (err) {
    await discard();
    throw err;
  }

  if (result.newSong) {
    notifyNewSong(ctx, { actor: user, project: access.project, song: result.newSong });
  } else if ((access.scope === "song" || access.scope === "track") && result.trackVersionId) {
    notifyVersionUploaded(ctx, {
      actor: user,
      project: access.project,
      song: access.song,
      versionId: result.trackVersionId,
    });
  }
  notifyQuotaFor(ctx, user);
  const { projectId, songId, newSong, ...body } = result;
  if (newSong) {
    ctx.hub.publish({ type: "song.created", projectId, songId, data: { songId } });
  }
  ctx.hub.publish({
    type: target.type === "projectImage" ? "project.updated" : "version.created",
    projectId,
    songId,
    data: { ...body },
  });
  return newSong ? { ...body, songId } : body;
}

type CommitResult = UploadResult & {
  projectId: string;
  songId: string | null;
  /** The song a `newSong` upload created. */
  newSong: SongRow | null;
};

// The tus hooks have no Fastify request, so events are recorded directly.
function recordUploadEvent(
  ctx: AppContext,
  req: Request,
  user: UserRow,
  r: CommitResult,
  target: UploadTarget,
): void {
  const common = {
    actorUserId: user.id,
    projectId: r.projectId,
    songId: r.songId,
    ip: ipOf(req),
    apiKeyId: apiKeyIdOf(req),
    userAgent: req.headers.get("user-agent"),
  };
  if (target.type === "projectImage") {
    recordEvent(ctx.db, {
      ...common,
      action: "project.updated",
      targetType: "project",
      targetId: r.projectId,
      details: { changes: ["image"] },
    });
  } else {
    if (r.newSong) {
      recordEvent(ctx.db, {
        ...common,
        action: "song.created",
        targetType: "song",
        targetId: r.newSong.id,
        details: { title: r.newSong.title },
      });
    }
    const audio =
      target.type === "newTrack" || target.type === "newVersion" || target.type === "newSong"
        ? target
        : null;
    const recording = audio?.source === "recording";
    recordEvent(ctx.db, {
      ...common,
      action: recording ? "version.recorded" : "version.uploaded",
      targetType: "trackVersion",
      targetId: r.trackVersionId,
      details: {
        trackId: r.trackId,
        assetId: r.assetId,
        ...(audio?.options && { options: audio.options }),
        ...(audio?.offsetSamples !== undefined && { offsetSamples: audio.offsetSamples }),
        ...(audio?.gainDb !== undefined && { gainDb: audio.gainDb }),
      },
    });
  }
}

/**
 * The branding logo (SPEC §25.1): stored as pending until `image.ingest` (logo mode) has made it
 * 64 px high and checked the 4:1 limit; the logo in use stays until then.
 */
function finishLogoUpload(
  ctx: AppContext,
  req: Request,
  user: UserRow,
  input: {
    uploadId: string;
    filename: string;
    blob: Parameters<typeof createOriginalAsset>[2];
    hash: string;
    discard: () => Promise<void>;
  },
): Promise<UploadResult> | UploadResult {
  const { db } = ctx;
  const now = Date.now();
  try {
    return db.transaction(() => {
      const asset = createOriginalAsset(
        db,
        {
          kind: "image",
          originalFilename: input.filename,
          sizeBytes: input.blob.sizeBytes,
          originalHash: input.hash,
          uploadedBy: user.id,
        },
        input.blob,
        now,
      );
      completeUploadSession(db, input.uploadId, now);
      setSetting(db, "branding.logoPendingAssetId", asset.id, now);
      enqueueLogoIngest(db, { assetId: asset.id, createdBy: user.id });
      recordEvent(db, {
        actorUserId: user.id,
        ip: ipOf(req),
        apiKeyId: apiKeyIdOf(req),
        userAgent: req.headers.get("user-agent"),
        action: "settings.changed",
        targetType: "settings",
        details: { changes: ["logo"], assetId: asset.id },
      });
      return { assetId: asset.id, trackId: null, trackVersionId: null };
    });
  } catch (err) {
    return input.discard().then(() => {
      throw err;
    });
  }
}
