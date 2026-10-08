import {
  API_PREFIX,
  brandingLogoPath,
  isAudioName,
  joinBasePath,
  trackNamesFromFiles,
} from "@bandroom/shared";
import { basePathFromDocument } from "../config/clientConfig";
import { linkPathPrefix } from "../links/linkMode";
import { expandZip, isZipFile } from "./zip";

let basePath: string | null = null;

/** Set once at startup (same base path as the API client). */
export function setMediaBasePath(p: string): void {
  basePath = p;
}

export function blobUrl(hash: string): string {
  return joinBasePath(
    basePath ?? basePathFromDocument(),
    `${API_PREFIX}${linkPathPrefix()}/blobs/${hash}`,
  );
}

/** The public branding logo (SPEC §25.1); never below a link's API root. */
export function brandingLogoUrl(hash: string): string {
  return joinBasePath(basePath ?? basePathFromDocument(), `${API_PREFIX}${brandingLogoPath(hash)}`);
}

/** A project as a ZIP (SPEC §28.7); the service worker leaves `…/download` alone. */
export function exportUrl(projectId: string, format: string): string {
  return joinBasePath(
    basePath ?? basePathFromDocument(),
    `${API_PREFIX}/projects/${projectId}/export/download?format=${format}`,
  );
}

export function downloadUrl(versionId: string, format: string): string {
  return joinBasePath(
    basePath ?? basePathFromDocument(),
    `${API_PREFIX}${linkPathPrefix()}/track-versions/${versionId}/download?format=${format}`,
  );
}

export function apiUrl(path: string): string {
  return joinBasePath(
    basePath ?? basePathFromDocument(),
    `${API_PREFIX}${linkPathPrefix()}${path}`,
  );
}

/** "3:07" — durations in lists (the player shows m:ss.mmm, SPEC §12). */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Locale-aware file size (SPEC §12: Intl APIs). */
export function formatBytes(bytes: number, locale: string): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[i],
    unitDisplay: "short",
    maximumFractionDigits: v < 10 && i > 0 ? 1 : 0,
  }).format(v);
}

export function isProbablyAudio(file: File): boolean {
  return file.type.startsWith("audio/") || isAudioName(file.name);
}

// Shared with brctl so the CLI names tracks like the web folder drop (SPEC §5.1).
export { isAudioName, trackNamesFromFiles };

/** Name normalization for matching files to tracks: lowercase letters and digits only. */
export function normalizeName(name: string): string {
  return name
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export interface MatchProposal {
  file: string;
  /** Suggested track name when creating a new track. */
  newName: string;
  /** Existing track to add a version to, or null for a new track. */
  trackId: string | null;
}

/**
 * Proposes where each dropped file goes (SPEC §5.1 auto-matching): an existing track with the same
 * normalized name (after removing the batch's common prefix), else the track whose name is
 * contained in the file name (≥ 3 chars), else a new track. Each track is used at most once.
 */
export function proposeMatches(
  files: readonly string[],
  tracks: readonly { id: string; name: string }[],
): MatchProposal[] {
  const names = trackNamesFromFiles(files);
  const used = new Set<string>();
  const norm = tracks.map((t) => ({ id: t.id, n: normalizeName(t.name) }));
  const pick = (pred: (n: string) => boolean) =>
    norm.find((t) => !used.has(t.id) && t.n.length > 0 && pred(t.n))?.id ?? null;
  return files.map((file, i) => {
    const newName = names[i] ?? file;
    const f = normalizeName(newName);
    const trackId = pick((n) => n === f) ?? pick((n) => n.length >= 3 && f.includes(n));
    if (trackId) used.add(trackId);
    return { file, newName, trackId };
  });
}

/** A dropped or picked file with its relative path (react-dropzone `path`, zip entries). */
export type PathFile = File & { path?: string };

/**
 * The relative path of a dropped, picked or unpacked file ("Song/bass.wav"): react-dropzone's
 * `path` ("/Song/bass.wav", "./bass.wav"), else the folder picker's `webkitRelativePath`, else the
 * name.
 */
export function pathOf(file: { name: string; path?: string; webkitRelativePath?: string }): string {
  const raw = file.path || file.webkitRelativePath || file.name;
  return raw.replace(/^\.?\/+/, "");
}

function withPath(file: File, path: string): PathFile {
  const copy = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
  return Object.assign(copy, { path });
}

/**
 * Re-roots files from one archive or picked folder for a project (SPEC §28.1): a single common
 * top folder is stripped, files in a subfolder keep it (one song per subfolder), and loose files
 * go under `root` (one song named after the zip or folder).
 */
export function rerootFiles(files: readonly PathFile[], root: string): PathFile[] {
  const split = files.map((f) => pathOf(f).split("/").filter(Boolean));
  const top = split[0]?.[0];
  const common = top !== undefined && split.every((parts) => parts.length >= 2 && parts[0] === top);
  return files.map((f, i) => {
    const parts = common ? (split[i] ?? []).slice(1) : (split[i] ?? []);
    return withPath(
      f,
      parts.length >= 2 ? parts.join("/") : `${root}/${parts.join("/") || f.name}`,
    );
  });
}

/** Dropped or picked files ready for upload; `failedZips` could not be unpacked. */
export interface PreparedFiles {
  files: PathFile[];
  skipped: number;
  failedZips: string[];
}

/**
 * Prepares dropped or picked files for upload (SPEC §28.1): zips are unpacked in the browser and
 * non-audio files are counted as skipped. In `project` mode a zip's entries (and a picked folder,
 * `picked`) are re-rooted with {@link rerootFiles} so subfolders become songs and loose files one
 * song named after the zip or folder; in `song` mode the result is a flat list of audio files.
 */
export async function prepareDroppedFiles(
  input: readonly PathFile[],
  mode: "project" | "song",
  picked = false,
): Promise<PreparedFiles> {
  const out: PathFile[] = [];
  const failedZips: string[] = [];
  let skipped = 0;
  const loose: PathFile[] = [];
  for (const file of input) {
    if (isZipFile(file)) {
      try {
        const zip = await expandZip(file, isAudioName);
        skipped += zip.skipped;
        const root = file.name.replace(/\.zip$/i, "") || file.name;
        out.push(...(mode === "project" ? rerootFiles(zip.files, root) : zip.files));
      } catch {
        failedZips.push(file.name);
      }
    } else if (isProbablyAudio(file)) {
      loose.push(file);
    } else {
      skipped++;
    }
  }
  if (picked && mode === "project" && loose.length > 0) {
    const root = pathOf(loose[0] ?? { name: "" }).split("/")[0] ?? "";
    out.unshift(...rerootFiles(loose, root));
  } else {
    out.unshift(...loose);
  }
  return { files: out, skipped, failedZips };
}

/** Groups dropped files by their top folder ({@link pathOf}, e.g. "Song/bass.wav" → "Song"). */
export function groupByFolder(
  files: readonly { name: string; path?: string; webkitRelativePath?: string }[],
): { folder: string | null; indexes: number[] }[] {
  const groups = new Map<string | null, number[]>();
  files.forEach((f, i) => {
    const parts = pathOf(f).split("/").filter(Boolean);
    const folder = parts.length >= 2 ? (parts[0] ?? null) : null;
    const list = groups.get(folder) ?? [];
    list.push(i);
    groups.set(folder, list);
  });
  return [...groups.entries()].map(([folder, indexes]) => ({ folder, indexes }));
}
