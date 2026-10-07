import { describe, expect, it } from "vitest";
import { newItem, offlineItemFor, offlineQualityFor, playableFrom } from "./items";

const normal = { quality: "normal", lossless: false } as const;

describe("offline items", () => {
  it("creates a downloading item; a song item holds its own song", () => {
    const song = newItem("song", "s1", "Song", "p1", normal, 42);
    expect(song).toMatchObject({
      key: "song:s1",
      kind: "song",
      id: "s1",
      title: "Song",
      projectId: "p1",
      addedAt: 42,
      syncedAt: null,
      autoUpdate: true,
      quality: "normal",
      lossless: false,
      status: "downloading",
      bytes: 0,
      songIds: ["s1"],
    });
    expect(newItem("project", "p1", "P", "p1", normal, 0).songIds).toEqual([]);
  });

  it("finds the item holding a song, preferring the song item", () => {
    const project = { ...newItem("project", "p1", "P", "p1", normal, 0), songIds: ["s1", "s2"] };
    const song = newItem("song", "s1", "S", "p1", normal, 0);
    expect(offlineItemFor("s1", [project, song])).toBe(song);
    expect(offlineItemFor("s2", [project, song])).toBe(project);
    expect(offlineItemFor("s3", [project, song])).toBeUndefined();
  });

  it("plays the downloaded quality while offline", () => {
    const item = newItem("song", "s", "S", "p", normal, 0);
    expect(offlineQualityFor(true, item, "lossless")).toBe("lossless");
    expect(offlineQualityFor(false, undefined, "low")).toBe("low");
    expect(offlineQualityFor(false, item, "lossless")).toBe("high");
    expect(offlineQualityFor(false, { ...item, lossless: true }, "lossless")).toBe("lossless");
    expect(offlineQualityFor(false, { ...item, lossless: true }, "high")).toBe("high");
    expect(offlineQualityFor(false, { ...item, quality: "small" }, "high")).toBe("low");
  });

  it("plays offline only files the offline copy holds", () => {
    const item = { ...newItem("song", "s", "S", "p", normal, 0), blobs: ["h1"] };
    expect(playableFrom(true, item, "h2")).toBe(true);
    expect(playableFrom(false, undefined, "h2")).toBe(true);
    expect(playableFrom(false, item, "h1")).toBe(true);
    expect(playableFrom(false, item, "h2")).toBe(false);
  });
});
