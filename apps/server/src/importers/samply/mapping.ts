import {
  stripExtension,
  type ImportNode,
  type ImportProject,
  type ImportVersion,
} from "@bandroom/shared";
import type { SamplyBox, SamplyProject } from "./api";

/**
 * Pure mapping logic for the Samply importer (SPEC §17.1 steps 3–4): box tree → proposed mapping
 * (default heuristics) → plan of songs/tracks/versions/documents the import job executes.
 */

const AUDIO_EXT = /\.(wav|wave|aif|aiff|flac|alac|m4a|mp3|aac|ogg|oga|opus|wv|caf)$/i;

export function isAudioFile(box: SamplyBox): boolean {
  return box.object === "file" && ((box.duration ?? 0) > 0 || AUDIO_EXT.test(box.name));
}

export type DocumentKind = "markdown" | "text" | "pdf" | "image" | "midi" | "other";

export function documentKind(name: string): DocumentKind {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "txt") return "text";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "heic"].includes(ext)) return "image";
  if (ext === "mid" || ext === "midi") return "midi";
  return "other";
}

/**
 * Samply's stock artwork (`…/samply-a03ff-public/img/default-artwork/13.png`) shown for projects
 * without a picture of their own. It is not a project picture, so the importer ignores it.
 */
export function isDefaultArtwork(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.includes("/default-artwork/");
  } catch {
    return false;
  }
}

/** Project artwork URL, or null when there is none or it is Samply's stock artwork. */
export function projectArtworkUrl(url: string | null | undefined): string | null {
  return url && !isDefaultArtwork(url) ? url : null;
}

/** Lower-cased file name at the end of a Samply artwork URL (`…/files/<id>/cover.jpeg`). */
export function artworkFileName(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    return last ? decodeURIComponent(last).toLowerCase() : null;
  } catch {
    return null;
  }
}

export interface ScanInfo {
  commentCounts: ReadonlyMap<string, number>;
  sizes: ReadonlyMap<string, number | null>;
  /** Samply file ids already imported (import_map). */
  imported: ReadonlySet<string>;
}

function versionOf(box: SamplyBox, info: ScanInfo): ImportVersion {
  return {
    id: box.id,
    name: box.name,
    durationSec: box.duration ?? null,
    sizeBytes: info.sizes.get(box.id) ?? null,
    timeCreated: box.timeCreated ?? null,
    commentCount: info.commentCounts.get(box.id) ?? 0,
    imported: info.imported.has(box.id),
  };
}

/** Builds the proposed mapping of one project (default heuristics, SPEC §17.1 step 3). */
export function proposeProject(
  project: SamplyProject,
  boxes: SamplyBox[],
  info: ScanInfo,
  existingProjectId: string | null,
): ImportProject {
  const live = boxes.filter((b) => !b.trashed && !b.hidden);
  const byId = new Map(live.map((b) => [b.id, b]));
  const childIds = new Set(live.flatMap((b) => b.children.map((c) => c.id)));

  const toNode = (box: SamplyBox): ImportNode => {
    const kids = box.children.map((c) => byId.get(c.id)).filter((b) => b !== undefined);
    if (box.object === "folder") {
      return {
        id: box.id,
        kind: "folder",
        name: box.name,
        action: "container",
        targetId: null,
        trackName: box.name,
        isAudio: false,
        versions: [],
        children: kids.map(toNode),
      };
    }
    // Stack versions in upload order (v1 = oldest); a lone file is its own single version.
    const files = box.object === "stack" ? kids.filter((k) => k.object === "file") : [box];
    const versions = files
      .map((f) => versionOf(f, info))
      .sort((a, b) => (a.timeCreated ?? 0) - (b.timeCreated ?? 0));
    const isAudio = files.some(isAudioFile);
    return {
      id: box.id,
      kind: box.object,
      name: stripExtension(box.name),
      action: isAudio ? "songSingle" : "document",
      targetId: null,
      trackName: stripExtension(box.name),
      isAudio,
      versions,
      children: [],
    };
  };

  // Nothing is merged automatically: every audio item starts as its own song. The admin groups
  // items into multitrack songs in review; lengths may differ, all tracks start at 0 (owner
  // decisions 2026-09-28 and 2026-10-05, DECISIONS.md, SPEC §26.5).
  const nodes = live.filter((b) => !childIds.has(b.id)).map(toNode);
  // Samply lists the project picture as an ordinary file, often a hidden one; recognise it by the
  // artwork URL's name. A visible match stays where it is; otherwise a hidden file box with that
  // name is added as the picture node (other hidden boxes stay out of the tree).
  const artworkUrl = projectArtworkUrl(project.artwork);
  const artworkName = artworkFileName(artworkUrl);
  if (artworkName) {
    const visible = nodes.find(
      (n) =>
        n.kind !== "folder" &&
        !n.isAudio &&
        n.versions.some((v) => v.name.toLowerCase() === artworkName),
    );
    if (visible) {
      visible.isArtwork = true;
      visible.action = "skip";
    } else {
      const hidden = boxes.find(
        (b) =>
          b.object === "file" &&
          !b.trashed &&
          b.hidden === true &&
          b.name.toLowerCase() === artworkName,
      );
      if (hidden) {
        nodes.push({
          id: hidden.id,
          kind: "file",
          name: stripExtension(hidden.name),
          action: "skip",
          targetId: null,
          trackName: stripExtension(hidden.name),
          isAudio: false,
          isArtwork: true,
          versions: [versionOf(hidden, info)],
          children: [],
        });
      }
    }
  }
  return {
    samplyId: project.id,
    name: project.name,
    color: project.color ?? null,
    artworkUrl,
    sizeBytes: project.size ?? null,
    include: true,
    existingProjectId,
    nodes,
  };
}

// Plan, validation and totals are shared with the review UI.
export {
  computeTotals,
  stripCommonPrefix,
  stripExtension,
  planProject,
  validateMapping,
  walkNodes,
  type PlannedSong,
  type PlannedTrack,
  type ProjectPlan,
} from "@bandroom/shared";
