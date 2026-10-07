import { API_PREFIX, brandingLogoPath, joinBasePath } from "@bandroom/shared";
import { basePathFromDocument } from "../config/clientConfig";
import { linkPathPrefix } from "../links/linkMode";

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

const AUDIO_EXT = /\.(wav|wave|aif|aiff|flac|mp3|m4a|aac|ogg|oga|opus|wv|alac)$/i;

export function isProbablyAudio(file: File): boolean {
  return file.type.startsWith("audio/") || AUDIO_EXT.test(file.name);
}

/**
 * Track names for a batch of dropped files (SPEC §5.1): extension and the common prefix removed,
 * e.g. `MySong_Bass.wav`, `MySong_Drums.wav` → "Bass", "Drums".
 */
export function trackNamesFromFiles(names: readonly string[]): string[] {
  const bases = names.map((n) => n.replace(/\.[^.]+$/, ""));
  if (bases.length < 2) return bases.map((b) => b.trim() || "Track");
  let prefix = bases[0] ?? "";
  for (const b of bases) {
    while (!b.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  // Only cut at a separator so "Bass" and "Bassoon" do not become "" and "oon".
  const cut = Math.max(
    prefix.lastIndexOf("_"),
    prefix.lastIndexOf("-"),
    prefix.lastIndexOf(" "),
    prefix.lastIndexOf("."),
  );
  const strip = cut >= 0 ? cut + 1 : 0;
  return bases.map(
    (b) =>
      b
        .slice(strip)
        .replace(/^[\s_\-.]+/, "")
        .trim() ||
      b.trim() ||
      "Track",
  );
}

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

/** Groups dropped files by their top folder (react-dropzone `path`, e.g. "/Song/bass.wav"). */
export function groupByFolder(
  files: readonly { name: string; path?: string }[],
): { folder: string | null; indexes: number[] }[] {
  const groups = new Map<string | null, number[]>();
  files.forEach((f, i) => {
    const parts = (f.path ?? f.name)
      .replace(/^\.?\//, "")
      .split("/")
      .filter(Boolean);
    const folder = parts.length >= 2 ? (parts[0] ?? null) : null;
    const list = groups.get(folder) ?? [];
    list.push(i);
    groups.set(folder, list);
  });
  return [...groups.entries()].map(([folder, indexes]) => ({ folder, indexes }));
}
