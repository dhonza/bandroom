import fs from "node:fs";
import path from "node:path";
import {
  createProject,
  createSong,
  isAudioName,
  listProjectSongs,
  listTrackVersions,
  trackNamesFromFiles,
  type UploadOptions,
} from "@bandroom/shared";
import { RemoteError, type Client } from "./client";
import { formatBytes } from "./format";

/** A local audio file planned as a new track. */
export interface PlannedFile {
  file: string;
  /** Track name (SPEC §5.1: extension and the batch's common prefix removed). */
  name: string;
  bytes: number;
}

export interface PlannedSong {
  title: string;
  files: PlannedFile[];
}

/** A folder entry that is not uploaded, with the reason. */
export interface Skipped {
  path: string;
  reason: "not audio" | "zip (unzip it first)" | "folder";
}

/** A finished upload, or a file that could not be uploaded. */
export interface UploadedFile extends PlannedFile {
  trackId: string | null;
  trackVersionId: string | null;
  /** Version status after `--wait` ("ready", "failed", or still processing on timeout). */
  status?: string;
  error?: string;
}

export interface Failure {
  file: string;
  error: string;
}

/** The track name limit of the upload target (`newTrack.name`). */
const TRACK_NAME_MAX = 120;

const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** Hidden entries (".DS_Store", macOS "._x.wav" resource forks) are ignored silently. */
function visibleEntries(dir: string): fs.Dirent[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => byName(a.name, b.name));
}

/**
 * The audio files directly in `dir`, sorted by name, named like the web folder drop; other files
 * (and subfolders, unless `folders` is false) are reported as skipped. Paths in `skipped` are
 * relative to `base`.
 */
export function scanSongFolder(
  dir: string,
  base: string,
  folders = true,
): { files: PlannedFile[]; skipped: Skipped[] } {
  const audio: string[] = [];
  const skipped: Skipped[] = [];
  for (const e of visibleEntries(dir)) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full) || e.name;
    if (e.isDirectory()) {
      if (folders) skipped.push({ path: rel, reason: "folder" });
    } else if (!e.isFile()) {
      skipped.push({ path: rel, reason: "not audio" });
    } else if (isAudioName(e.name)) {
      audio.push(full);
    } else {
      skipped.push({
        path: rel,
        reason: /\.zip$/i.test(e.name) ? "zip (unzip it first)" : "not audio",
      });
    }
  }
  const names = trackNamesFromFiles(audio.map((f) => path.basename(f)));
  return {
    files: audio.map((file, i) => ({
      file,
      name: (names[i] ?? path.basename(file)).slice(0, TRACK_NAME_MAX).trim() || "Track",
      bytes: fs.statSync(file).size,
    })),
    skipped,
  };
}

/**
 * Songs of a project folder (SPEC §28.1, like the web project folder drop): each subfolder with
 * audio is a song named after it, and loose audio files at the top are one song named after the
 * folder. Audio deeper than one subfolder is skipped.
 */
export function scanProjectFolder(dir: string): { songs: PlannedSong[]; skipped: Skipped[] } {
  const songs: PlannedSong[] = [];
  const skipped: Skipped[] = [];
  const top = scanSongFolder(dir, dir, false);
  skipped.push(...top.skipped);
  if (top.files.length > 0) songs.push({ title: path.basename(dir), files: top.files });
  for (const e of visibleEntries(dir)) {
    if (!e.isDirectory()) continue;
    const sub = scanSongFolder(path.join(dir, e.name), dir);
    skipped.push(...sub.skipped);
    if (sub.files.length > 0) songs.push({ title: e.name, files: sub.files });
  }
  return { songs, skipped };
}

const sameTitle = (a: string, b: string) =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/**
 * Throws when a planned song title is taken in the project or repeats in the plan: re-running a
 * folder upload never creates duplicate songs.
 */
export async function checkSongTitles(
  client: Client,
  projectId: string | null,
  titles: readonly string[],
): Promise<void> {
  const existing = projectId
    ? (await client.call(listProjectSongs, { params: { id: projectId } })).songs
    : [];
  const clashes: string[] = [];
  titles.forEach((t, i) => {
    const song = existing.find((s) => sameTitle(s.title, t));
    if (song)
      clashes.push(
        `"${t}" already exists (song ${song.id}); add files with: pnpm remote upload <file> --song ${song.id} --name <track>`,
      );
    else if (titles.findIndex((o) => sameTitle(o, t)) !== i)
      clashes.push(`"${t}" appears twice in the folder; rename one of the folders`);
  });
  if (clashes.length > 0) throw new SongExistsError(clashes);
}

/** A command that cannot go on; the CLI prints the message (no usage) and exits non-zero. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

export class SongExistsError extends CommandError {
  constructor(readonly clashes: string[]) {
    super(`Nothing uploaded:\n  ${clashes.join("\n  ")}`);
    this.name = "SongExistsError";
  }
}

/** Some files failed; the summary is printed already. The CLI exits non-zero. */
export class PartialFailureError extends CommandError {
  constructor(readonly failures: Failure[]) {
    super(
      `${failures.length} file(s) failed:\n  ${failures.map((f) => `${f.file}: ${f.error}`).join("\n  ")}`,
    );
    this.name = "PartialFailureError";
  }
}

function errorText(err: unknown): string {
  if (err instanceof RemoteError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export async function createProjectNamed(
  client: Client,
  name: string,
  description?: string,
): Promise<string> {
  const { project } = await client.call(createProject, {
    body: { name, ...(description !== undefined && { description }) },
  });
  return project.id;
}

export async function createSongTitled(
  client: Client,
  projectId: string,
  title: string,
): Promise<string> {
  const { song } = await client.call(createSong, { params: { id: projectId }, body: { title } });
  return song.id;
}

/**
 * Creates the song and uploads its files one at a time as new tracks (a 1-vCPU server processes
 * them in order anyway). A failed file is recorded and the rest continue.
 */
export async function uploadSong(
  client: Client,
  projectId: string,
  song: PlannedSong,
  options: UploadOptions | undefined,
  log: (line: string) => void,
): Promise<{ songId: string | null; files: UploadedFile[]; failures: Failure[] }> {
  let songId: string;
  try {
    songId = await createSongTitled(client, projectId, song.title);
  } catch (err) {
    const error = `song "${song.title}" not created: ${errorText(err)}`;
    log(error);
    return {
      songId: null,
      files: song.files.map((f) => ({ ...f, trackId: null, trackVersionId: null, error })),
      failures: song.files.map((f) => ({ file: f.file, error })),
    };
  }
  log(`song "${song.title}" ${songId}`);
  const files: UploadedFile[] = [];
  const failures: Failure[] = [];
  for (const f of song.files) {
    try {
      const r = await client.upload(f.file, {
        type: "newTrack",
        songId,
        name: f.name,
        ...(options && { options }),
      });
      files.push({ ...f, trackId: r.trackId, trackVersionId: r.trackVersionId });
      log(`  ${f.name} <- ${path.basename(f.file)} (${formatBytes(f.bytes)})`);
    } catch (err) {
      const error = errorText(err);
      files.push({ ...f, trackId: null, trackVersionId: null, error });
      failures.push({ file: f.file, error });
      log(`  ${f.name} <- ${path.basename(f.file)} FAILED: ${error}`);
    }
  }
  return { songId, files, failures };
}

/**
 * Polls until every version is ready or failed, or the time runs out (then the last status
 * stays, e.g. "processing"). Returns the status per version id.
 */
export async function waitForVersions(
  client: Client,
  items: readonly { trackId: string; trackVersionId: string }[],
  { timeoutMs = 10 * 60_000, intervalMs = 2000 } = {},
): Promise<Map<string, string>> {
  const status = new Map<string, string>();
  const until = Date.now() + timeoutMs;
  let pending = [...items];
  for (;;) {
    const still: typeof pending = [];
    for (const it of pending) {
      const { versions } = await client.call(listTrackVersions, { params: { id: it.trackId } });
      const s = versions.find((v) => v.id === it.trackVersionId)?.status ?? "unknown";
      status.set(it.trackVersionId, s);
      if (s !== "ready" && s !== "failed" && s !== "unknown") still.push(it);
    }
    pending = still;
    if (pending.length === 0 || Date.now() > until) return status;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** The plan as text (`--dry-run`, and the header of a real run). */
export function describePlan(
  project: string,
  songs: readonly PlannedSong[],
  skipped: readonly Skipped[],
): string {
  const lines = [`project: ${project}`];
  for (const s of songs) {
    lines.push(`song "${s.title}" (${s.files.length} track(s))`);
    for (const f of s.files)
      lines.push(`  ${f.name} <- ${path.basename(f.file)} (${formatBytes(f.bytes)})`);
  }
  if (songs.length === 0) lines.push("no audio files found");
  if (skipped.length > 0) {
    lines.push(`skipped ${skipped.length}:`);
    for (const s of skipped) lines.push(`  ${s.path} (${s.reason})`);
  }
  return lines.join("\n");
}
