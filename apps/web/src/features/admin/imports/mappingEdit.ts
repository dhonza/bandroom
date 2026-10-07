import {
  nodeDuration,
  lengthsDiffer,
  stripCommonPrefix,
  walkNodes,
  type ImportAction,
  type ImportMapping,
  type ImportNode,
  type ImportProject,
  type ImportRun,
} from "@bandroom/shared";

/**
 * Editing rules for the review tree (SPEC §17.1 step 4). Every change returns a new mapping that
 * stays consistent: `trackOf` nodes always point at a song. Nothing is grouped automatically; the
 * admin selects items and makes them one multitrack song (owner decision). Lengths may differ:
 * a warning, never a block; the tracks start together (owner decision 2026-10-05, SPEC §26.5).
 */

export function actionsFor(node: ImportNode): ImportAction[] {
  // "Multitrack song" is created by grouping; it is listed only for nodes that already are one.
  const multi: ImportAction[] = node.action === "songMultitrack" ? ["songMultitrack"] : [];
  if (node.kind === "folder") return [...multi, "container", "skip"];
  if (node.isAudio) return ["songMix", ...multi, "trackOf", "skip"];
  return ["document", "skip"];
}

const isSong = (n: ImportNode) => n.action === "songMix" || n.action === "songMultitrack";

/** Songs a node can become a track of, or a document can be attached to (not itself). */
export function songTargets(project: ImportProject, exceptId?: string): ImportNode[] {
  const out: ImportNode[] = [];
  walkNodes(project.nodes, (n) => {
    if (isSong(n) && n.id !== exceptId) out.push(n);
  });
  return out;
}

export function findNode(nodes: ImportNode[], id: string): ImportNode | undefined {
  let hit: ImportNode | undefined;
  walkNodes(nodes, (n) => {
    if (n.id === id) hit = n;
  });
  return hit;
}

function edit(
  mapping: ImportMapping,
  projectId: string,
  fn: (project: ImportProject) => boolean,
): ImportMapping {
  const next = structuredClone(mapping);
  const project = next.projects.find((p) => p.samplyId === projectId);
  return project && fn(project) ? next : mapping;
}

/** Items whose song goes away: their tracks and attached documents fall back to defaults. */
function releaseDependents(project: ImportProject, songId: string): void {
  walkNodes(project.nodes, (n) => {
    if (n.targetId !== songId) return;
    if (n.action === "trackOf") n.action = "songMix";
    n.targetId = null;
  });
}

export function setNodeAction(
  mapping: ImportMapping,
  projectId: string,
  nodeId: string,
  action: ImportAction,
  targetId: string | null = null,
): ImportMapping {
  return edit(mapping, projectId, (project) => {
    const node = findNode(project.nodes, nodeId);
    if (!node || !actionsFor(node).includes(action)) return false;
    const wasSong = isSong(node);
    if (action === "trackOf") {
      const target = targetId ?? songTargets(project, node.id)[0]?.id ?? null;
      if (!target) return false; // nothing to attach to
      node.targetId = target;
    } else {
      node.targetId = null;
    }
    node.action = action;
    if (wasSong && !isSong(node)) releaseDependents(project, node.id);
    if (action === "skip") {
      walkNodes(node.children, (n) => {
        if (isSong(n)) releaseDependents(project, n.id);
        n.action = "skip";
        n.targetId = null;
      });
    }
    return true;
  });
}

/** Whether `node` may join a multitrack group: any audio item (lengths may differ). */
export function canGroup(node: ImportNode): boolean {
  return node.kind !== "folder" && node.isAudio;
}

/** Whether the picked items differ in length (a warning only, SPEC §26.5). */
export function groupLengthsDiffer(nodes: readonly ImportNode[]): boolean {
  return lengthsDiffer(nodes.map(nodeDuration));
}

/** Default title of a group: the names' common prefix ("Tune - Bass", "Tune - Drums" → "Tune"). */
export function suggestTitle(nodes: ImportNode[]): string {
  const first = nodes[0]?.name ?? "";
  if (nodes.length < 2) return first;
  let prefix = first;
  for (const n of nodes.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.name.length && prefix[i] === n.name[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const title = prefix.replace(/[\s\-_.(]+$/, "").trim();
  return title.length >= 2 ? title : first;
}

/**
 * Makes the selected items one multitrack song: the first becomes the song (and its first track),
 * the others its tracks. Track names drop the common prefix. Items of another length are fine:
 * all tracks start at 0.
 */
export function groupAsMultitrack(
  mapping: ImportMapping,
  projectId: string,
  nodeIds: string[],
  title: string,
): ImportMapping {
  if (nodeIds.length < 2) return mapping;
  return edit(mapping, projectId, (project) => {
    const nodes = nodeIds.map((id) => findNode(project.nodes, id));
    if (nodes.some((n) => !n)) return false;
    const group = nodes as ImportNode[];
    const anchor = group[0] as ImportNode;
    if (!group.every(canGroup)) return false;
    for (const n of group) if (isSong(n) && n !== anchor) releaseDependents(project, n.id);
    const names = stripCommonPrefix(group.map((n) => n.name));
    group.forEach((n, i) => {
      n.trackName = names[i] ?? n.name;
      if (n === anchor) {
        n.action = "songMultitrack";
        n.targetId = null;
        n.songTitle = title.trim().slice(0, 200) || anchor.name;
      } else {
        n.action = "trackOf";
        n.targetId = anchor.id;
      }
    });
    return true;
  });
}

export function setTrackName(
  mapping: ImportMapping,
  projectId: string,
  nodeId: string,
  trackName: string,
): ImportMapping {
  return edit(mapping, projectId, (project) => {
    const node = findNode(project.nodes, nodeId);
    if (node) node.trackName = trackName.slice(0, 120);
    return Boolean(node);
  });
}

export function setSongTitle(
  mapping: ImportMapping,
  projectId: string,
  nodeId: string,
  songTitle: string,
): ImportMapping {
  return edit(mapping, projectId, (project) => {
    const node = findNode(project.nodes, nodeId);
    if (node) node.songTitle = songTitle.slice(0, 200);
    return Boolean(node);
  });
}

/** Attaches a document to a song (or back to the project with `null`). */
export function setDocumentTarget(
  mapping: ImportMapping,
  projectId: string,
  nodeId: string,
  songId: string | null,
): ImportMapping {
  return edit(mapping, projectId, (project) => {
    const node = findNode(project.nodes, nodeId);
    if (node?.action !== "document") return false;
    node.targetId = songId;
    return true;
  });
}

export function setProjectIncluded(
  mapping: ImportMapping,
  projectId: string,
  include: boolean,
): ImportMapping {
  return {
    ...mapping,
    projects: mapping.projects.map((p) => (p.samplyId === projectId ? { ...p, include } : p)),
  };
}

// ——— display helpers ———————————————————————————————————————————————————————————————————

/** A song target's label: the multitrack song title, else the item name. */
export function songLabel(n: ImportNode): string {
  return n.action === "songMultitrack" ? n.songTitle?.trim() || n.name : n.name;
}

/** Totals shown on a tree row: bytes and comments over all versions, length, all imported. */
export function nodeStats(node: ImportNode) {
  return {
    size: node.versions.reduce((s, v) => s + (v.sizeBytes ?? 0), 0),
    comments: node.versions.reduce((s, v) => s + v.commentCount, 0),
    duration: nodeDuration(node),
    allImported: node.versions.length > 0 && node.versions.every((v) => v.imported),
  };
}

/** Report kinds counted per item kind (`admin.import.kind.*`). */
export type KindKey = "project" | "song" | "track" | "version" | "document" | "comment" | "insight";

/** What a dry run planned, per kind ("song.planned": 3 → ["song", 3]), in report order. */
export function dryRunPlannedCounts(counts: Record<string, number>): [KindKey, number][] {
  return Object.entries(counts)
    .filter(([k]) => k.endsWith(".planned"))
    .map(([k, n]) => [k.split(".")[0] as KindKey, n]);
}

/** A run's title: its included projects, or "" before a mapping exists. */
export function runTitle(run: Pick<ImportRun, "mapping">): string {
  return (
    run.mapping?.projects
      .filter((p) => p.include)
      .map((p) => p.name)
      .join(", ") ?? ""
  );
}
