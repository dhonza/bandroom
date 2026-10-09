import {
  canActOn,
  type Song,
  type Track,
  type UploadOptions,
  type UploadTarget,
} from "@bandroom/shared";
import type { MatchProposal } from "../../lib/media";
import { uploadOptions } from "../../upload/prefs";

/**
 * Where an uploaded file goes: a new version of the matched track, else a new track; with this
 * device's upload settings (SPEC §28.2) unless they are the defaults.
 */
export function uploadTargetFor(
  songId: string,
  proposal: MatchProposal,
  options: UploadOptions | undefined = uploadOptions(),
): UploadTarget {
  const opts = options ? { options } : {};
  return proposal.trackId
    ? { type: "newVersion", trackId: proposal.trackId, ...opts }
    : { type: "newTrack", songId, name: proposal.newName, ...opts };
}

/** What the user may do with a track row (SPEC §3: own items vs. everyone's by role). */
export function trackPermissions(song: Song, track: Track, userId: string) {
  const role = song.access.role;
  const v = track.current;
  return {
    canDelete: canActOn(role, "delete", track.createdBy === userId),
    canEditTrack: canActOn(role, "edit", track.createdBy === userId),
    canRetry: v !== null && canActOn(role, "edit", v.uploadedBy === userId),
    canUpload: song.access.capabilities.includes("upload"),
    // Adjust position (SPEC §9): the version's uploader, the track's creator or an editor.
    canAdjust:
      v !== null && canActOn(role, "edit", v.uploadedBy === userId || track.createdBy === userId),
  };
}
