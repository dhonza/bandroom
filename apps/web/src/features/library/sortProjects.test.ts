import { describe, expect, it } from "vitest";
import { filterProjects, sortProjects, sortTime } from "./sortProjects";

const p = (
  name: string,
  extra: Partial<{
    starred: boolean;
    createdAt: number;
    updatedAt: number;
    lastAccessedAt: number | null;
    createdBy: string | null;
  }> = {},
) => ({
  name,
  starred: false,
  createdAt: 0,
  updatedAt: 0,
  lastAccessedAt: null,
  createdBy: null,
  ...extra,
});

const names = (list: { name: string }[]) => list.map((x) => x.name);

describe("sortProjects", () => {
  const list = [
    p("bravo", { createdAt: 2, updatedAt: 30, lastAccessedAt: 5 }),
    p("Alpha", { createdAt: 3, updatedAt: 10, lastAccessedAt: null }),
    p("delta", { createdAt: 1, updatedAt: 20, lastAccessedAt: 9, starred: true }),
    p("charlie", { createdAt: 4, updatedAt: 40, lastAccessedAt: 7, starred: true }),
  ];

  it("pins starred projects and sorts by name within each group", () => {
    expect(names(sortProjects(list, "name", "asc"))).toEqual([
      "charlie",
      "delta",
      "Alpha",
      "bravo",
    ]);
    expect(names(sortProjects(list, "name", "desc"))).toEqual([
      "delta",
      "charlie",
      "bravo",
      "Alpha",
    ]);
  });

  it("sorts by creation and modification time in both orders", () => {
    expect(names(sortProjects(list, "created", "asc"))).toEqual([
      "delta",
      "charlie",
      "bravo",
      "Alpha",
    ]);
    expect(names(sortProjects(list, "modified", "desc"))).toEqual([
      "charlie",
      "delta",
      "bravo",
      "Alpha",
    ]);
  });

  it("puts never-accessed projects last in either order", () => {
    expect(names(sortProjects(list, "accessed", "desc"))).toEqual([
      "delta",
      "charlie",
      "bravo",
      "Alpha",
    ]);
    const unstarred = list.filter((x) => !x.starred);
    expect(names(sortProjects(unstarred, "accessed", "asc"))).toEqual(["bravo", "Alpha"]);
    expect(names(sortProjects([...unstarred].reverse(), "accessed", "asc"))).toEqual([
      "bravo",
      "Alpha",
    ]);
  });

  it("breaks ties by name and leaves the input alone", () => {
    const tied = [p("b", { updatedAt: 1 }), p("a", { updatedAt: 1 })];
    expect(names(sortProjects(tied, "modified", "desc"))).toEqual(["a", "b"]);
    expect(names(tied)).toEqual(["b", "a"]);
  });

  it("names the time shown for a sort key", () => {
    const x = p("x", { createdAt: 1, updatedAt: 2, lastAccessedAt: 3 });
    expect([sortTime(x, "created"), sortTime(x, "modified"), sortTime(x, "accessed")]).toEqual([
      1, 2, 3,
    ]);
    expect(sortTime(x, "name")).toBe(2);
  });
});

describe("filterProjects", () => {
  const list = [p("mine", { createdBy: "me" }), p("theirs", { createdBy: "you" }), p("gone")];
  it("splits by creator", () => {
    expect(names(filterProjects(list, "all", "me"))).toEqual(["mine", "theirs", "gone"]);
    expect(names(filterProjects(list, "mine", "me"))).toEqual(["mine"]);
    expect(names(filterProjects(list, "shared", "me"))).toEqual(["theirs", "gone"]);
  });
});
