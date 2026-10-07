import type { ImportMapping, ImportNode } from "@bandroom/shared";
import { computeTotals, planProject, validateMapping } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import {
  actionsFor,
  canGroup,
  groupLengthsDiffer,
  dryRunPlannedCounts,
  groupAsMultitrack,
  nodeStats,
  runTitle,
  setDocumentTarget,
  setNodeAction,
  setProjectIncluded,
  setSongTitle,
  setTrackName,
  songLabel,
  songTargets,
  suggestTitle,
} from "./mappingEdit";

const node = (
  id: string,
  kind: ImportNode["kind"],
  extra: Partial<ImportNode> & { duration?: number } = {},
): ImportNode => {
  const { duration = 180, ...rest } = extra;
  return {
    id,
    kind,
    name: id,
    action: kind === "folder" ? "container" : "songSingle",
    targetId: null,
    trackName: id,
    isAudio: kind !== "folder",
    versions:
      kind === "folder"
        ? []
        : [
            {
              id: `${id}-f`,
              name: `${id}.wav`,
              durationSec: duration,
              sizeBytes: 100,
              timeCreated: 1,
              commentCount: 0,
              imported: false,
            },
          ],
    children: [],
    ...rest,
  };
};

function mapping(): ImportMapping {
  return {
    includeInsights: false,
    scannedAt: 0,
    projects: [
      {
        samplyId: "p",
        name: "P",
        color: null,
        artworkUrl: null,
        sizeBytes: null,
        include: true,
        existingProjectId: null,
        nodes: [
          node("Tune", "folder", {
            children: [
              node("Tune - Bass", "stack"),
              node("Tune - Drums", "file"),
              node("Tune - Idea", "file", { duration: 42 }),
              node("lyrics", "file", { isAudio: false, action: "document" }),
            ],
          }),
          node("Single", "stack"),
        ],
      },
    ],
  };
}

const project = (m: ImportMapping) => {
  const p = m.projects[0];
  if (!p) throw new Error("project");
  return p;
};
const kid = (m: ImportMapping, i: number) => project(m).nodes[0]?.children[i] as ImportNode;

describe("mapping edits", () => {
  it("offers no folder grouping; multitrack appears only on grouped items", () => {
    const m = mapping();
    expect(actionsFor(project(m).nodes[0] as ImportNode)).toEqual(["container", "skip"]);
    expect(actionsFor(kid(m, 0))).toEqual(["songSingle", "trackOf", "skip"]);
    expect(actionsFor(kid(m, 3))).toEqual(["document", "skip"]);
    const g = groupAsMultitrack(m, "p", ["Tune - Bass", "Tune - Drums"], "Tune");
    expect(actionsFor(kid(g, 0))).toEqual(["songSingle", "songMultitrack", "trackOf", "skip"]);
  });

  it("groups audio items into one multitrack song, whatever their length", () => {
    const m = mapping();
    expect(canGroup(kid(m, 1))).toBe(true);
    expect(canGroup(kid(m, 2))).toBe(true); // different length: a warning only (SPEC §26.5)
    expect(canGroup(kid(m, 3))).toBe(false); // not audio
    expect(groupLengthsDiffer([kid(m, 0), kid(m, 1)])).toBe(false);
    expect(groupLengthsDiffer([kid(m, 0), kid(m, 2)])).toBe(true);
    expect(suggestTitle([kid(m, 0), kid(m, 1)])).toBe("Tune");

    const g = groupAsMultitrack(m, "p", ["Tune - Bass", "Tune - Drums"], "Tune");
    const plan = planProject(project(g));
    const tune = plan.songs.find((s) => s.title === "Tune");
    expect(tune?.tracks.map((t) => t.name)).toEqual(["Bass", "Drums"]);
    expect(computeTotals(g)).toMatchObject({ songs: 3, tracks: 4 });
    expect(validateMapping(g)).toEqual([]);
    // A group including a different-length item is fine; a lone item or a document is not.
    const mixed = groupAsMultitrack(m, "p", ["Tune - Bass", "Tune - Idea"], "X");
    expect(mixed).not.toBe(m);
    expect(kid(mixed, 2)).toMatchObject({ action: "trackOf", targetId: "Tune - Bass" });
    expect(groupAsMultitrack(m, "p", ["Tune - Bass"], "X")).toBe(m);
    expect(groupAsMultitrack(m, "p", ["Tune - Bass", "lyrics"], "X")).toBe(m);
  });

  it("attaches documents to songs and releases them when the song goes", () => {
    let m = groupAsMultitrack(mapping(), "p", ["Tune - Bass", "Tune - Drums"], "Tune");
    m = setDocumentTarget(m, "p", "lyrics", "Tune - Bass");
    let plan = planProject(project(m));
    expect(plan.songs.find((s) => s.title === "Tune")?.documents.map((d) => d.name)).toEqual([
      "lyrics",
    ]);
    m = setNodeAction(m, "p", "Tune - Bass", "skip");
    expect(kid(m, 1).action).toBe("songSingle");
    expect(kid(m, 3).targetId).toBeNull();
    plan = planProject(project(m));
    expect(plan.projectDocuments.map((d) => d.name)).toEqual(["lyrics"]);
    expect(validateMapping(m)).toEqual([]);
  });

  it("attaches a track to another song and edits names", () => {
    let m = setNodeAction(mapping(), "p", "Tune - Idea", "trackOf", "Single");
    expect(songTargets(project(m), "Tune - Idea").map((n) => n.id)).toEqual([
      "Tune - Bass",
      "Tune - Drums",
      "Single",
    ]);
    expect(planProject(project(m)).songs.find((s) => s.title === "Single")?.tracks).toHaveLength(2);
    m = setTrackName(m, "p", "Tune - Idea", "Vocal idea");
    expect(kid(m, 2).trackName).toBe("Vocal idea");
    m = groupAsMultitrack(m, "p", ["Tune - Bass", "Tune - Drums"], "Tune");
    m = setSongTitle(m, "p", "Tune - Bass", "Tune (live)");
    expect(planProject(project(m)).songs.map((s) => s.title)).toContain("Tune (live)");
  });

  it("ignores invalid actions, skips folders recursively, excludes projects", () => {
    const m0 = mapping();
    expect(setNodeAction(m0, "p", "lyrics", "songSingle")).toBe(m0);
    expect(setDocumentTarget(m0, "p", "Single", "Tune - Bass")).toBe(m0);
    const skipped = setNodeAction(m0, "p", "Tune", "skip");
    expect(project(skipped).nodes[0]?.children.every((c) => c.action === "skip")).toBe(true);
    expect(computeTotals(setProjectIncluded(m0, "p", false)).songs).toBe(0);
  });
});

describe("display helpers", () => {
  it("labels song targets by their multitrack title, else the name", () => {
    expect(songLabel(node("a", "file"))).toBe("a");
    expect(songLabel(node("a", "file", { action: "songMultitrack", songTitle: " Intro " }))).toBe(
      "Intro",
    );
    expect(songLabel(node("a", "file", { action: "songMultitrack", songTitle: "  " }))).toBe("a");
  });

  it("sums sizes and comments over versions", () => {
    const n = node("a", "stack", { duration: 60 });
    const v = n.versions[0];
    if (!v) throw new Error("fixture");
    const stack = {
      ...n,
      versions: [v, { ...v, id: "b", sizeBytes: null, commentCount: 2, imported: true }],
    };
    expect(nodeStats(stack)).toEqual({
      size: 100,
      comments: 2,
      duration: 60,
      allImported: false,
    });
    const done = { ...stack, versions: stack.versions.map((x) => ({ ...x, imported: true })) };
    expect(nodeStats(done).allImported).toBe(true);
    expect(nodeStats(node("f", "folder")).allImported).toBe(false);
  });

  it("lists what a dry run planned", () => {
    expect(
      dryRunPlannedCounts({ "song.planned": 3, "song.created": 1, "track.planned": 5 }),
    ).toEqual([
      ["song", 3],
      ["track", 5],
    ]);
  });

  it("titles a run by its included projects", () => {
    expect(runTitle({ mapping: null })).toBe("");
    const m = mapping();
    expect(runTitle({ mapping: m })).toBe("P");
    expect(
      runTitle({ mapping: { ...m, projects: m.projects.map((p) => ({ ...p, include: false })) } }),
    ).toBe("");
  });
});
