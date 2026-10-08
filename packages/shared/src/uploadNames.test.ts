import { describe, expect, it } from "vitest";
import { isAudioName, trackNamesFromFiles } from "./uploadNames";

describe("trackNamesFromFiles", () => {
  it("removes extensions and the common prefix at a separator", () => {
    expect(
      trackNamesFromFiles(["MySong_Bass.wav", "MySong_Drums.wav", "MySong_Lead Vox.wav"]),
    ).toEqual(["Bass", "Drums", "Lead Vox"]);
    expect(trackNamesFromFiles(["Bass.wav", "Bassoon.wav"])).toEqual(["Bass", "Bassoon"]);
    expect(trackNamesFromFiles(["song-01 - gtr.flac", "song-01 - keys.flac"])).toEqual([
      "gtr",
      "keys",
    ]);
    expect(trackNamesFromFiles(["Mix.mp3"])).toEqual(["Mix"]);
  });
});

describe("isAudioName", () => {
  it("recognizes audio extensions case-insensitively", () => {
    expect(isAudioName("bass.WAV")).toBe(true);
    expect(isAudioName("take.flac")).toBe(true);
    expect(isAudioName("notes.txt")).toBe(false);
    expect(isAudioName("songs.zip")).toBe(false);
  });
});
