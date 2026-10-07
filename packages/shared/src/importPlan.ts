import type {
  ImportMapping,
  ImportNode,
  ImportProject,
  ImportTotals,
  ImportVersion,
} from "./imports";

/**
 * Resolving a reviewed Samply mapping into songs/tracks/documents (SPEC §17.1 steps 4–5). Pure,
 * shared by the import job and the review UI (live totals and validation).
 */

export function stripExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim() || name;
}

/**
 * Common leading text of track names cut at a separator ("Song - Bass", "Song - Drums" →
 * "Bass", "Drums"). Returns the names unchanged when nothing sensible remains.
 */
export function stripCommonPrefix(names: string[]): string[] {
  const bare = names.map(stripExtension);
  if (bare.length < 2) return bare;
  let prefix = bare[0] ?? "";
  for (const n of bare.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i]?.toLowerCase() === n[i]?.toLowerCase())
      i++;
    prefix = prefix.slice(0, i);
  }
  // Cut back to the last separator so words are not split ("Bas|s" vs "Bas|ic").
  const cut = Math.max(...[" ", "-", "_", "."].map((s) => prefix.lastIndexOf(s)));
  prefix = cut >= 0 ? prefix.slice(0, cut + 1) : "";
  if (!prefix) return bare;
  const stripped = bare.map((n) =>
    n
      .slice(prefix.length)
      .replace(/^[\s\-_.]+/, "")
      .trim(),
  );
  // Bare numbers ("Take 1" → "1") or duplicates are worse than the full names.
  const useful =
    stripped.every((s) => s.length > 0 && !/^\d+$/.test(s)) &&
    new Set(stripped.map((s) => s.toLowerCase())).size === stripped.length;
  return useful ? stripped : bare;
}

/** Length of an item's newest version in seconds (null if unknown). */
export function nodeDuration(n: ImportNode): number | null {
  return n.versions.at(-1)?.durationSec ?? null;
}

/**
 * Whether two items can be stems of one multitrack song: the same length within 0.5 s (or
 * 0.5 % for long recordings). Unknown lengths never match.
 */
export function sameLength(a: number | null, b: number | null): boolean {
  if (a === null || b === null || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) <= Math.max(0.5, Math.max(a, b) * 0.005);
}

export interface PlannedTrack {
  node: ImportNode;
  name: string;
}

export interface PlannedSong {
  node: ImportNode;
  title: string;
  tracks: PlannedTrack[];
  documents: ImportNode[];
}

export interface ProjectPlan {
  songs: PlannedSong[];
  projectDocuments: ImportNode[];
  /** Nodes that could not be placed (e.g. `trackOf` without a valid target). */
  problems: { node: ImportNode; reason: string }[];
}

export function walkNodes(nodes: ImportNode[], fn: (n: ImportNode) => void): void {
  for (const n of nodes) {
    fn(n);
    walkNodes(n.children, fn);
  }
}

/** Resolves a reviewed project mapping into songs to create (SPEC §17.1 step 5). */
export function planProject(project: ImportProject): ProjectPlan {
  const songs = new Map<string, PlannedSong>();
  const plan: ProjectPlan = { songs: [], projectDocuments: [], problems: [] };
  const deferredTracks: ImportNode[] = [];
  const deferredDocs: ImportNode[] = [];

  const visit = (nodes: ImportNode[], song: PlannedSong | null) => {
    for (const n of nodes) {
      switch (n.action) {
        case "skip":
          break;
        case "songSingle": {
          // One track named after the song (SPEC §17.1, M21).
          const s: PlannedSong = {
            node: n,
            title: n.name,
            tracks: [{ node: n, name: n.name }],
            documents: [],
          };
          songs.set(n.id, s);
          plan.songs.push(s);
          break;
        }
        case "songMultitrack": {
          // A grouped audio item is the song's first track; a folder's tracks point at it.
          const s: PlannedSong = {
            node: n,
            title: n.songTitle?.trim() || n.name,
            tracks: n.kind === "folder" ? [] : [{ node: n, name: n.trackName || n.name }],
            documents: [],
          };
          songs.set(n.id, s);
          plan.songs.push(s);
          visit(n.children, s);
          break;
        }
        case "container":
          visit(n.children, null);
          break;
        case "trackOf":
          deferredTracks.push(n);
          break;
        case "document":
          // An explicit target song wins; else the enclosing multitrack folder, else the project.
          if (n.targetId) deferredDocs.push(n);
          else if (song) song.documents.push(n);
          else plan.projectDocuments.push(n);
          break;
      }
    }
  };
  visit(project.nodes, null);

  for (const n of deferredTracks) {
    const target = n.targetId ? songs.get(n.targetId) : undefined;
    if (!target) {
      plan.problems.push({ node: n, reason: "track target is not a song" });
    } else if (!n.isAudio) {
      plan.problems.push({ node: n, reason: "not an audio file" });
    } else {
      target.tracks.push({ node: n, name: n.trackName || n.name });
    }
  }
  for (const n of deferredDocs) {
    const target = n.targetId ? songs.get(n.targetId) : undefined;
    if (target) target.documents.push(n);
    else plan.projectDocuments.push(n); // target song was skipped: keep it on the project
  }
  return plan;
}

/** Problems that block starting the import (review step validation). */
export function validateMapping(mapping: ImportMapping): string[] {
  const errors: string[] = [];
  for (const p of mapping.projects.filter((x) => x.include)) {
    for (const { node, reason } of planProject(p).problems) {
      errors.push(`${p.name} / ${node.name}: ${reason}`);
    }
    walkNodes(p.nodes, (n) => {
      const needsAudio =
        n.action === "songSingle" ||
        n.action === "trackOf" ||
        (n.action === "songMultitrack" && n.kind !== "folder");
      if (needsAudio && !n.isAudio) errors.push(`${p.name} / ${n.name}: not an audio file`);
    });
  }
  return [...new Set(errors)];
}

export function computeTotals(mapping: ImportMapping): ImportTotals {
  const t: ImportTotals = {
    songs: 0,
    tracks: 0,
    versions: 0,
    documents: 0,
    comments: 0,
    bytes: 0,
    alreadyImported: 0,
  };
  const countFiles = (vs: ImportVersion[], audio: boolean) => {
    for (const v of vs) {
      t.comments += v.commentCount;
      if (v.imported) t.alreadyImported++;
      else {
        if (audio) t.versions++;
        t.bytes += v.sizeBytes ?? 0;
      }
    }
  };
  for (const p of mapping.projects.filter((x) => x.include)) {
    const plan = planProject(p);
    t.songs += plan.songs.length;
    for (const s of plan.songs) {
      t.tracks += s.tracks.length;
      for (const tr of s.tracks) countFiles(tr.node.versions, true);
      t.documents += s.documents.length;
      for (const d of s.documents) countFiles(d.versions, false);
    }
    t.documents += plan.projectDocuments.length;
    for (const d of plan.projectDocuments) countFiles(d.versions, false);
  }
  return t;
}
