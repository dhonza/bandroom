import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, trackNamesFromFiles } from "./media";

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

describe("formatting", () => {
  it("formats durations and sizes", () => {
    expect(formatDuration(187.4)).toBe("3:07");
    expect(formatDuration(0)).toBe("0:00");
    expect(formatBytes(512, "en")).toBe("512 byte");
    expect(formatBytes(1536, "en")).toBe("1.5 kB");
    expect(formatBytes(5 * 1024 ** 3, "cs")).toMatch(/^5\sGB$/);
  });
});

import { groupByFolder, normalizeName, proposeMatches } from "./media";

describe("proposeMatches", () => {
  const tracks = [
    { id: "b", name: "Bass" },
    { id: "d", name: "Drums" },
    { id: "v", name: "Lead Vox" },
  ];
  it("matches by normalized name, then containment, else proposes a new track", () => {
    expect(normalizeName("Lead Vóx!")).toBe("leadvox");
    expect(
      proposeMatches(
        ["Song_Bass.wav", "Song_Drums v2.wav", "Song_Lead Vox.wav", "Song_Keys.wav"],
        tracks,
      ),
    ).toEqual([
      { file: "Song_Bass.wav", newName: "Bass", trackId: "b" },
      { file: "Song_Drums v2.wav", newName: "Drums v2", trackId: "d" },
      { file: "Song_Lead Vox.wav", newName: "Lead Vox", trackId: "v" },
      { file: "Song_Keys.wav", newName: "Keys", trackId: null },
    ]);
  });
  it("uses each track only once", () => {
    const r = proposeMatches(["x_bass.wav", "x_bass2.wav"], tracks);
    expect(r.map((m) => m.trackId)).toEqual(["b", null]);
  });
});

describe("groupByFolder", () => {
  it("groups by top folder; loose files have no folder", () => {
    expect(
      groupByFolder([
        { name: "a.wav", path: "/Song A/a.wav" },
        { name: "b.wav", path: "./Song A/b.wav" },
        { name: "c.wav", path: "/Song B/sub/c.wav" },
        { name: "loose.wav", path: "loose.wav" },
      ]),
    ).toEqual([
      { folder: "Song A", indexes: [0, 1] },
      { folder: "Song B", indexes: [2] },
      { folder: null, indexes: [3] },
    ]);
  });
});
