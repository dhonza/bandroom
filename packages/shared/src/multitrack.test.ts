import { describe, expect, it } from "vitest";
import {
  lengthsDiffer,
  MakeMultitrackSchema,
  multitrackTrackNames,
  SongsToProjectSchema,
  suggestMultitrackName,
} from "./multitrack";

describe("suggestMultitrackName (SPEC §26.5)", () => {
  it("takes the longest common substring, trimmed of separators", () => {
    expect(suggestMultitrackName(["Blue Moon - Bass", "Blue Moon - Drums"])).toBe("Blue Moon");
    expect(
      suggestMultitrackName(["01_Blue Moon_bass", "02_Blue Moon_gtr", "Blue Moon (vox)"]),
    ).toBe("Blue Moon");
    expect(suggestMultitrackName(["Bass – Night Train", "Drums – Night Train"])).toBe(
      "Night Train",
    );
  });

  it("ignores case and keeps the spelling of the shortest name", () => {
    expect(suggestMultitrackName(["NIGHT TRAIN bass", "night train"])).toBe("night train");
  });

  it("falls back to the first name when the common part is shorter than 3 characters", () => {
    expect(suggestMultitrackName(["Alpha", "Beta"])).toBe("Alpha");
    expect(suggestMultitrackName(["Song A - x", "Tune B - y"])).toBe("Song A - x");
    // " - " is common but nothing is left after trimming.
    expect(suggestMultitrackName(["ab - cd", "ef - gh"])).toBe("ab - cd");
  });

  it("returns the only name for one source, and empty for none", () => {
    expect(suggestMultitrackName(["  Solo  "])).toBe("Solo");
    expect(suggestMultitrackName(["Same", "same"])).toBe("Same");
    expect(suggestMultitrackName([])).toBe("");
  });
});

describe("lengthsDiffer", () => {
  it("warns beyond the importer's tolerance, ignoring unknown lengths", () => {
    expect(lengthsDiffer([180, 180.4])).toBe(false);
    expect(lengthsDiffer([180, 181])).toBe(true);
    expect(lengthsDiffer([558, 560, 559])).toBe(false);
    expect(lengthsDiffer([180, null, 30])).toBe(true);
    expect(lengthsDiffer([180, null])).toBe(false);
    expect(lengthsDiffer([0, 180])).toBe(false);
    expect(lengthsDiffer([])).toBe(false);
  });
});

describe("bodies", () => {
  it("need items and exactly one target", () => {
    const ok = { tracks: ["a"], name: "Song", targetProjectId: "p" };
    expect(MakeMultitrackSchema.safeParse(ok).success).toBe(true);
    expect(MakeMultitrackSchema.safeParse({ ...ok, tracks: [] }).success).toBe(false);
    expect(MakeMultitrackSchema.safeParse({ ...ok, newProject: { name: "X" } }).success).toBe(
      false,
    );
    expect(
      MakeMultitrackSchema.safeParse({ songs: ["s"], name: "Song", newProject: { name: "X" } })
        .success,
    ).toBe(true);
    expect(
      MakeMultitrackSchema.safeParse({ tracks: ["a"], name: " ", targetProjectId: "p" }).success,
    ).toBe(false);
    expect(SongsToProjectSchema.safeParse({ songs: ["s"], targetProjectId: "p" }).success).toBe(
      true,
    );
    expect(SongsToProjectSchema.safeParse({ songs: ["s"] }).success).toBe(false);
    expect(SongsToProjectSchema.safeParse({ songs: [], targetProjectId: "p" }).success).toBe(false);
  });
});

describe("multitrackTrackNames (SPEC §26.5)", () => {
  const src = (name: string, songId: string, songTitle: string) => ({ name, songId, songTitle });

  it("names a song's only track after the song", () => {
    expect(
      multitrackTrackNames([
        src("Mix", "a", "Bass"),
        src("Track 1", "b", " Gtr 1 "),
        src("Drums", "c", "Band"),
        src("Keys", "c", "Band"),
      ]),
    ).toEqual([
      { name: "Bass" },
      { name: "Gtr 1" },
      { name: "Drums" }, // not the song's only track
      { name: "Keys" },
    ]);
  });

  it("keeps a lone track and blank titles as they are", () => {
    expect(multitrackTrackNames([src("Mix", "a", "Bass")])).toEqual([{ name: "Mix" }]);
    expect(multitrackTrackNames([src("Bass", "a", "Song A"), src("Mix", "b", "  ")])).toEqual([
      { name: "Song A" },
      { name: "Mix" },
    ]);
  });

  it("cuts long song titles to the track name limit", () => {
    const [first] = multitrackTrackNames([src("Mix", "a", "x".repeat(300)), src("Mix", "b", "y")]);
    expect(first?.name).toHaveLength(120);
  });
});
