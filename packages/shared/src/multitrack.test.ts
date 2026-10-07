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
  const src = (name: string, role: "track" | "mix", songId: string, songTitle: string) => ({
    name,
    role,
    songId,
    songTitle,
  });

  it("names a song's only mix track after the song and makes it a track", () => {
    expect(
      multitrackTrackNames([
        src("Mix", "mix", "a", "Bass"),
        src("Mix", "mix", "b", " Gtr 1 "),
        src("Drums", "track", "c", "Band"),
        src("Mix", "mix", "c", "Band"),
      ]),
    ).toEqual([
      { name: "Bass", role: "track" },
      { name: "Gtr 1", role: "track" },
      { name: "Drums", role: "track" },
      { name: "Mix", role: "mix" }, // not the song's only track
    ]);
  });

  it("keeps a lone track, normal tracks and blank titles as they are", () => {
    expect(multitrackTrackNames([src("Mix", "mix", "a", "Bass")])).toEqual([
      { name: "Mix", role: "mix" },
    ]);
    expect(
      multitrackTrackNames([src("Bass", "track", "a", "Song A"), src("Mix", "mix", "b", "  ")]),
    ).toEqual([
      { name: "Bass", role: "track" },
      { name: "Mix", role: "mix" },
    ]);
  });

  it("cuts long song titles to the track name limit", () => {
    const [first] = multitrackTrackNames([
      src("Mix", "mix", "a", "x".repeat(300)),
      src("Mix", "mix", "b", "y"),
    ]);
    expect(first?.name).toHaveLength(120);
  });
});
