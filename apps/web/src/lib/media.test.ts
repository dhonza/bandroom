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

import { strToU8, zipSync } from "fflate";
import {
  groupByFolder,
  normalizeName,
  pathOf,
  prepareDroppedFiles,
  proposeMatches,
  rerootFiles,
} from "./media";

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

describe("pathOf", () => {
  it("prefers the dropzone path, then the picker's relative path, then the name", () => {
    expect(pathOf({ name: "a.wav", path: "/Song/a.wav" })).toBe("Song/a.wav");
    expect(pathOf({ name: "a.wav", path: "./a.wav" })).toBe("a.wav");
    expect(pathOf({ name: "a.wav", webkitRelativePath: "Album/Song/a.wav" })).toBe(
      "Album/Song/a.wav",
    );
    expect(pathOf({ name: "a.wav", path: "", webkitRelativePath: "" })).toBe("a.wav");
  });
});

describe("rerootFiles (SPEC §28.1)", () => {
  const f = (path: string) =>
    Object.assign(new File(["x"], path.split("/").pop() ?? path), { path });
  const paths = (files: { path?: string }[]) => files.map((x) => x.path);

  it("strips a single common top folder and puts loose files under the root", () => {
    expect(
      paths(rerootFiles([f("Album/A/1.wav"), f("Album/B/2.wav"), f("Album/3.wav")], "Zip")),
    ).toEqual(["A/1.wav", "B/2.wav", "Zip/3.wav"]);
    expect(paths(rerootFiles([f("Album/1.wav"), f("Album/2.wav")], "Zip"))).toEqual([
      "Zip/1.wav",
      "Zip/2.wav",
    ]);
  });

  it("keeps subfolders when there is no common top folder", () => {
    expect(paths(rerootFiles([f("A/1.wav"), f("B/2.wav"), f("3.wav")], "Zip"))).toEqual([
      "A/1.wav",
      "B/2.wav",
      "Zip/3.wav",
    ]);
  });
});

describe("prepareDroppedFiles (SPEC §28.1)", () => {
  const zip = (entries: Record<string, string>, name: string) =>
    new File(
      [zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])))],
      name,
      { type: "application/zip" },
    );
  const audio = (name: string, path?: string) =>
    Object.assign(new File(["x"], name, { type: "audio/wav" }), path ? { path } : {});

  it("unpacks zips on a project: subfolders are songs, loose entries one song per zip", async () => {
    const r = await prepareDroppedFiles(
      [
        zip({ "Gig/A/1.wav": "1", "Gig/A/2.wav": "2", "Gig/B/3.wav": "3" }, "Gig.zip"),
        zip({ "x.wav": "x", "y.mp3": "y", "readme.txt": "r" }, "Demo.zip"),
        audio("loose.wav", "./loose.wav"),
        new File(["t"], "cover.png", { type: "image/png" }),
      ],
      "project",
    );
    expect(r.files.map((x) => pathOf(x))).toEqual([
      "loose.wav",
      "A/1.wav",
      "A/2.wav",
      "B/3.wav",
      "Demo/x.wav",
      "Demo/y.mp3",
    ]);
    expect(groupByFolder(r.files).map((g) => g.folder)).toEqual([null, "A", "B", "Demo"]);
    expect(r.skipped).toBe(2);
    expect(r.failedZips).toEqual([]);
  });

  it("flattens zips on a song and reports broken zips", async () => {
    const r = await prepareDroppedFiles(
      [zip({ "S/bass.wav": "b", "S/sub/gtr.wav": "g" }, "S.zip"), new File(["no"], "bad.zip")],
      "song",
    );
    expect(r.files.map((x) => x.name)).toEqual(["bass.wav", "gtr.wav"]);
    expect(r.failedZips).toEqual(["bad.zip"]);
  });

  it("treats a picked folder like a zip named after it", async () => {
    const picked = [
      Object.assign(new File(["1"], "1.wav"), { webkitRelativePath: "Album/A/1.wav" }),
      Object.assign(new File(["2"], "2.wav"), { webkitRelativePath: "Album/2.wav" }),
    ];
    // jsdom's File has no settable webkitRelativePath, so define it.
    picked.forEach((p, i) =>
      Object.defineProperty(p, "webkitRelativePath", {
        value: ["Album/A/1.wav", "Album/2.wav"][i],
      }),
    );
    const r = await prepareDroppedFiles(picked, "project", true);
    expect(r.files.map((x) => pathOf(x))).toEqual(["A/1.wav", "Album/2.wav"]);
  });
});
