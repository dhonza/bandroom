import { sameLength, type ImportMapping, type ImportNode } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SamplyBoxSchema, SamplyProjectSchema, type SamplyBox } from "./api";
import project0 from "./fixtures/project-0-all.json";
import project1 from "./fixtures/project-1-all.json";
import projectsFixture from "./fixtures/projects.json";
import {
  artworkFileName,
  computeTotals,
  documentKind,
  planProject,
  proposeProject,
  stripCommonPrefix,
  stripExtension,
  validateMapping,
  walkNodes,
  type ScanInfo,
} from "./mapping";

const projects = z.array(SamplyProjectSchema).parse(projectsFixture);
const boxes0 = z.array(SamplyBoxSchema).parse(project0);
const boxes1 = z.array(SamplyBoxSchema).parse(project1);
const emptyInfo: ScanInfo = { commentCounts: new Map(), sizes: new Map(), imported: new Set() };
const P = projects[0] ?? { id: "p", name: "P" };

let seq = 0;
function box(object: SamplyBox["object"], name: string, extra: Partial<SamplyBox> = {}): SamplyBox {
  seq++;
  return {
    id: `b${seq}`,
    object,
    name,
    color: "",
    timeCreated: seq,
    children: [],
    trashed: false,
    hidden: false,
    ...extra,
  };
}
const stackOf = (name: string, ...files: SamplyBox[]) =>
  box("stack", name, { children: files.map((f) => ({ id: f.id, name: f.name })) });
const folderOf = (name: string, ...kids: SamplyBox[]) =>
  box("folder", name, { children: kids.map((k) => ({ id: k.id, name: k.name })) });

const find = (nodes: ImportNode[], name: string): ImportNode => {
  let hit: ImportNode | undefined;
  walkNodes(nodes, (n) => {
    if (n.name === name) hit = n;
  });
  if (!hit) throw new Error(`no node ${name}`);
  return hit;
};
const mappingOf = (...ps: ReturnType<typeof proposeProject>[]): ImportMapping => ({
  projects: ps,
  includeInsights: false,
  scannedAt: 0,
});

describe("helpers", () => {
  it("strips extensions, common prefixes and classifies documents", () => {
    expect(stripExtension("Bass.wav")).toBe("Bass");
    expect(stripExtension("v1.2 mix")).toBe("v1.2 mix");
    expect(stripCommonPrefix(["Song - Bass.wav", "Song - Drums.wav"])).toEqual(["Bass", "Drums"]);
    expect(stripCommonPrefix(["Basic", "Bass"])).toEqual(["Basic", "Bass"]);
    expect(stripCommonPrefix(["Take 1", "Take 1"])).toEqual(["Take 1", "Take 1"]);
    expect(stripCommonPrefix(["Take 1", "Take 2"])).toEqual(["Take 1", "Take 2"]);
    expect(stripCommonPrefix(["Solo"])).toEqual(["Solo"]);
    expect(documentKind("lyrics.md")).toBe("markdown");
    expect(documentKind("notes.TXT")).toBe("text");
    expect(documentKind("chart.pdf")).toBe("pdf");
    expect(documentKind("cover.JPG")).toBe("image");
    expect(documentKind("tempo.mid")).toBe("midi");
    expect(documentKind("stems.zip")).toBe("other");
  });

  it("allows grouping only items of the same length", () => {
    expect(sameLength(180, 180.4)).toBe(true);
    expect(sameLength(558, 560)).toBe(true); // within 0.5 % of a long take
    expect(sameLength(180, 181)).toBe(false);
    expect(sameLength(558, 106)).toBe(false);
    expect(sameLength(180, null)).toBe(false);
  });
});

describe("proposeProject on recorded fixtures", () => {
  it("maps top-level stacks to songs and keeps a mixed-length folder as a container", () => {
    const p = proposeProject(P, boxes0, emptyInfo, null);
    const folder = p.nodes.find((n) => n.kind === "folder");
    expect(folder?.action).toBe("container");
    expect(folder?.children).toHaveLength(9);
    expect(folder?.children.every((c) => c.action === "songMix")).toBe(true);
    const plan = planProject(p);
    expect(plan.songs).toHaveLength(23);
    expect(plan.songs.every((s) => s.tracks.length === 1 && s.tracks[0]?.role === "mix")).toBe(
      true,
    );
  });

  it("maps a loose image to a project document", () => {
    const p = proposeProject(P, boxes1, emptyInfo, null);
    const plan = planProject(p);
    expect(plan.songs).toHaveLength(2);
    expect(plan.projectDocuments.map((d) => d.name)).toEqual(["Take 5"]);
    expect(p.nodes.map((n) => n.action)).toEqual(["songMix", "songMix", "document"]);
  });
});

describe("proposeProject heuristics", () => {
  it("never merges a folder on its own, even with equal-length items", () => {
    const bass = box("file", "Tune - Bass.wav", { duration: 200 });
    const drums = box("file", "Tune - Drums.wav", { duration: 200 });
    const lyrics = box("file", "lyrics.txt");
    const folder = folderOf("Tune", bass, drums, lyrics);
    const p = proposeProject(P, [folder, bass, drums, lyrics], emptyInfo, null);
    expect(find(p.nodes, "Tune").action).toBe("container");
    const plan = planProject(p);
    expect(plan.songs.map((s) => s.title)).toEqual(["Tune - Bass", "Tune - Drums"]);
    expect(plan.projectDocuments.map((d) => d.name)).toEqual(["lyrics"]);
  });

  it("plans a group of selected items as one multitrack song", () => {
    const bass = box("file", "Tune - Bass.wav", { duration: 200 });
    const drums = box("file", "Tune - Drums.wav", { duration: 200 });
    const p = proposeProject(P, [bass, drums], emptyInfo, null);
    const anchor = find(p.nodes, "Tune - Bass");
    anchor.action = "songMultitrack";
    anchor.songTitle = "Tune";
    anchor.trackName = "Bass";
    const other = find(p.nodes, "Tune - Drums");
    other.action = "trackOf";
    other.targetId = anchor.id;
    other.trackName = "Drums";
    const plan = planProject(p);
    expect(plan.songs).toHaveLength(1);
    expect(plan.songs[0]?.title).toBe("Tune");
    expect(plan.songs[0]?.tracks.map((t) => [t.name, t.role])).toEqual([
      ["Bass", "track"],
      ["Drums", "track"],
    ]);
    expect(validateMapping(mappingOf(p))).toEqual([]);
    expect(computeTotals(mappingOf(p))).toMatchObject({ songs: 1, tracks: 2, versions: 2 });
  });

  it("orders stack versions by upload time and ignores trashed boxes", () => {
    const v2 = box("file", "take2.wav", { duration: 10, timeCreated: 200 });
    const v1 = box("file", "take1.wav", { duration: 10, timeCreated: 100 });
    const gone = box("file", "old.wav", { duration: 10, trashed: true });
    const s = stackOf("Song", v2, v1, gone);
    const p = proposeProject(P, [s, v2, v1, gone], emptyInfo, null);
    expect(p.nodes).toHaveLength(1);
    expect(p.nodes[0]?.versions.map((v) => v.name)).toEqual(["take1.wav", "take2.wav"]);
  });

  it("keeps nested folders as containers and marks imported versions", () => {
    const a = box("file", "a.wav", { duration: 60 });
    const b = box("file", "b.wav", { duration: 60 });
    const inner = folderOf("Inner", a, b);
    const outer = folderOf("Outer", inner);
    const info: ScanInfo = {
      commentCounts: new Map([[a.id, 2]]),
      sizes: new Map([
        [a.id, 1000],
        [b.id, 500],
      ]),
      imported: new Set([b.id]),
    };
    const p = proposeProject(P, [outer, inner, a, b], info, "local-project");
    expect(find(p.nodes, "Outer").action).toBe("container");
    expect(find(p.nodes, "Inner").action).toBe("container");
    const totals = computeTotals(mappingOf(p));
    expect(totals).toMatchObject({
      songs: 2,
      tracks: 2,
      versions: 1,
      bytes: 1000,
      comments: 2,
      alreadyImported: 1,
    });
    expect(p.existingProjectId).toBe("local-project");
  });
});

describe("project picture", () => {
  it("recognises the file Samply keeps for the project picture", () => {
    expect(artworkFileName("https://cdn.samply.app/users/u/files/x-y/My%20Cover.JPEG")).toBe(
      "my cover.jpeg",
    );
    expect(artworkFileName("")).toBeNull();
    expect(artworkFileName("not a url")).toBeNull();
    const cover = box("file", "My Cover.jpeg");
    const other = box("file", "photo.jpeg");
    const withArt = { ...P, artwork: "https://cdn.samply.app/users/u/files/x/My%20Cover.jpeg" };
    const p = proposeProject(withArt, [other, cover], emptyInfo, null);
    expect(p.nodes.map((n) => [n.name, n.action, n.isArtwork ?? false])).toEqual([
      ["photo", "document", false],
      ["My Cover", "skip", true],
    ]);
    expect(planProject(p).projectDocuments.map((d) => d.name)).toEqual(["photo"]);
  });
});

describe("planProject and validation", () => {
  it("adds trackOf nodes to their target song and reports bad targets", () => {
    const mix = box("file", "Song.wav", { duration: 100 });
    const vocal = box("file", "Vocal idea.wav", { duration: 30 });
    const doc = box("file", "chart.pdf");
    const p = proposeProject(P, [mix, vocal, doc], emptyInfo, null);
    const vocalNode = find(p.nodes, "Vocal idea");
    vocalNode.action = "trackOf";
    vocalNode.targetId = find(p.nodes, "Song").id;
    const plan = planProject(p);
    expect(plan.songs).toHaveLength(1);
    expect(plan.songs[0]?.tracks.map((t) => t.name)).toEqual(["Mix", "Vocal idea"]);
    expect(validateMapping(mappingOf(p))).toEqual([]);

    vocalNode.targetId = "missing";
    const docNode = find(p.nodes, "chart");
    docNode.action = "songMix";
    const errors = validateMapping(mappingOf(p));
    expect(errors.some((e) => e.includes("Vocal idea") && e.includes("not a song"))).toBe(true);
    expect(errors.some((e) => e.includes("chart") && e.includes("not an audio"))).toBe(true);
  });

  it("skips excluded projects and skipped nodes", () => {
    const f = box("file", "x.wav", { duration: 5 });
    const p = proposeProject(P, [f], emptyInfo, null);
    expect(computeTotals(mappingOf(p)).songs).toBe(1);
    const node = p.nodes[0];
    if (node) node.action = "skip";
    expect(computeTotals(mappingOf(p)).songs).toBe(0);
    expect(computeTotals(mappingOf({ ...p, include: false })).songs).toBe(0);
    const folder = folderOf("F", box("file", "y.wav", { duration: 5 }));
    const multi = proposeProject(P, [folder], emptyInfo, null);
    const fnode = multi.nodes[0];
    if (fnode) fnode.action = "songMultitrack";
    expect(validateMapping(mappingOf(multi))).toEqual([]);
    const doc = proposeProject(P, [box("file", "notes.txt")], emptyInfo, null);
    const dnode = doc.nodes[0];
    if (dnode) dnode.action = "songMultitrack";
    expect(validateMapping(mappingOf(doc))[0]).toContain("not an audio file");
  });
});
