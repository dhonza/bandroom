import { DEFAULT_EDIT_SONG_NAMING } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { chosenRanges, chosenSet, titleRanges, toggleRange, type NamedRange } from "./bounceNaming";

const ranges: NamedRange[] = [
  { id: "c", name: "Outro", startFrame: 300, endFrame: 400 },
  { id: "a", name: "Intro", startFrame: 0, endFrame: 100 },
  { id: "b", name: "Verse", startFrame: 100, endFrame: 300 },
];

describe("split-into-songs ranges and titles", () => {
  it("keeps the chosen ranges in timeline order", () => {
    expect(chosenRanges(ranges, new Set(["c", "a"])).map((r) => r.id)).toEqual(["a", "c"]);
    expect(chosenSet(ranges, new Set(["b"]))).toEqual(new Set(["c", "a"]));
    expect(toggleRange(new Set(["a"]), "a")).toEqual(new Set());
    expect(toggleRange(new Set(["a"]), "b")).toEqual(new Set(["a", "b"]));
  });

  it("titles by name by default", () => {
    const all = titleRanges(
      ranges,
      chosenSet(ranges, new Set()),
      DEFAULT_EDIT_SONG_NAMING,
      "R",
      {},
    );
    expect(all.map((r) => r.title)).toEqual(["Intro", "Verse", "Outro"]);
  });

  it("numbers the chosen ranges only, with the session name", () => {
    const naming = {
      ...DEFAULT_EDIT_SONG_NAMING,
      numbered: true,
      title: "sessionAndName" as const,
    };
    const some = titleRanges(ranges, new Set(["a", "c"]), naming, "Rehearsal", {});
    expect(some.map((r) => r.title)).toEqual(["01 Rehearsal – Intro", "02 Rehearsal – Outro"]);
  });

  it("lets typed titles win; a blank one falls back to the default", () => {
    const naming = { ...DEFAULT_EDIT_SONG_NAMING, numbered: true };
    const some = titleRanges(ranges, new Set(["a", "c"]), naming, "R", { c: " Coda ", a: "  " });
    expect(some.map((r) => [r.title, r.edited])).toEqual([
      ["01 Intro", false],
      ["Coda", true],
    ]);
    expect(some[1]?.defaultTitle).toBe("02 Outro");
    const long = titleRanges(ranges, new Set(["a"]), naming, "R", { a: "x".repeat(300) });
    expect(long[0]?.title).toHaveLength(200);
  });
});
