import type { Song, Track, TrackVersion } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { trackPermissions, uploadTargetFor } from "./model";

const song = (role: Song["access"]["role"], capabilities: string[] = []): Song =>
  ({ id: "s", access: { role, capabilities } }) as unknown as Song;

const track = (createdBy: string, uploadedBy: string | null): Track =>
  ({
    id: "t",
    createdBy,
    current: uploadedBy === null ? null : ({ id: "v", uploadedBy } as TrackVersion),
  }) as Track;

describe("uploadTargetFor", () => {
  it("adds a version to a matched track, else creates a track", () => {
    expect(uploadTargetFor("s", { file: "a.wav", newName: "A", trackId: "t" })).toEqual({
      type: "newVersion",
      trackId: "t",
    });
    expect(uploadTargetFor("s", { file: "a.wav", newName: "A", trackId: null })).toEqual({
      type: "newTrack",
      songId: "s",
      name: "A",
    });
  });
});

describe("trackPermissions", () => {
  it("lets contributors act on their own tracks and versions only", () => {
    expect(trackPermissions(song("contributor", ["upload"]), track("me", "me"), "me")).toEqual({
      canDelete: true,
      canEditTrack: true,
      canRetry: true,
      canUpload: true,
    });
    expect(trackPermissions(song("contributor"), track("other", "other"), "me")).toEqual({
      canDelete: false,
      canEditTrack: false,
      canRetry: false,
      canUpload: false,
    });
  });

  it("lets editors act on everyone's tracks; no version means no retry", () => {
    expect(trackPermissions(song("editor"), track("other", "other"), "me")).toMatchObject({
      canDelete: true,
      canEditTrack: true,
      canRetry: true,
    });
    expect(trackPermissions(song("editor"), track("other", null), "me").canRetry).toBe(false);
  });
});
