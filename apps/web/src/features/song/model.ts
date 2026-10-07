import { canActOn, type Song, type Track, type UploadTarget } from "@bandroom/shared";
import type { MatchProposal } from "../../lib/media";

/** Where an uploaded file goes: a new version of the matched track, else a new track. */
export function uploadTargetFor(songId: string, proposal: MatchProposal): UploadTarget {
  return proposal.trackId
    ? { type: "newVersion", trackId: proposal.trackId }
    : { type: "newTrack", songId, name: proposal.newName, role: "track" };
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
  };
}
