import {
  getAsset,
  getBlob,
  getDocumentVersionRow,
  getVariant,
  listDocuments,
  listSongTracks,
  listVisibleSongs,
  planZip,
  uniquePath,
  zipPathSegment,
  type TrackListVersion,
  type UserRow,
  type ZipEntry,
} from "@bandroom/server-core";
import {
  hasCapability,
  type DownloadFormat,
  type ExportFormat,
  type ProjectExportPreview,
} from "@bandroom/shared";
import type { FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { AppError } from "./errors";
import { documentDownloadAllowed, downloadAllowed, type ProjectScopeAccess } from "./scope";
import { resolveDownload, streamWav, type DownloadSource } from "./versionDownload";

/**
 * Project export as a ZIP (SPEC §28.7): what goes in, under which names, and how to stream it.
 * Layout: `‹Project›/‹Song›/‹Track›.ext` for songs with two or more tracks, `‹Project›/‹Song›.ext`
 * for one-track songs, `‹Project›/Documents/‹title›.ext`. Current versions only.
 */

export interface ExportEntry {
  name: string;
  size: number;
  source: DownloadSource;
}

export interface ExportPlan {
  root: string;
  entries: ExportEntry[];
  preview: ProjectExportPreview;
}

type Choice = { format: DownloadFormat; fallback: "opus" | "original" | null } | null;

/**
 * The format a version is exported in, like the download menu (SPEC §5.6, §26.4): versions whose
 * full quality was removed give Opus; lossy sources (no FLAC) give the uploaded file.
 */
export function exportFormatOf(v: TrackListVersion, wanted: ExportFormat): Choice {
  if (v.asset.status !== "ready") return null;
  const has = new Set(v.variants.map((x) => x.variant));
  const opus: Choice = has.has("opus") ? { format: "opus", fallback: "opus" } : null;
  if (wanted === "opus") return has.has("opus") ? { format: "opus", fallback: null } : null;
  if (v.version.archivedAt !== null) return opus;
  if (wanted === "original")
    return has.has("original") ? { format: "original", fallback: null } : opus;
  const lossless = has.has("flac") || (has.has("original") && v.probe?.lossless === true);
  if (wanted === "flac" ? has.has("flac") : lossless) return { format: wanted, fallback: null };
  return has.has("original") ? { format: "original", fallback: "original" } : opus;
}

const extOf = (filename: string) => {
  const m = /\.[^./\\]{1,10}$/.exec(filename);
  return m ? m[0].toLowerCase() : "";
};

/** Plans the archive for `user` (who has `download` on the project). */
export async function planProjectExport(
  ctx: AppContext,
  user: UserRow,
  access: ProjectScopeAccess,
  format: ExportFormat,
): Promise<ExportPlan> {
  const { db } = ctx;
  const root = zipPathSegment(access.project.name);
  const taken = new Set<string>();
  const entries: ExportEntry[] = [];
  const preview = {
    files: 0,
    songs: 0,
    skippedSongs: 0,
    documents: 0,
    opusFallbacks: 0,
    originalFallbacks: 0,
    bytes: 0,
  };

  for (const { song, role } of listVisibleSongs(db, user, access.project.id)) {
    if (
      !hasCapability(role, "download") ||
      !downloadAllowed({ project: access.project, song, role })
    ) {
      preview.skippedSongs++;
      continue;
    }
    const files: { name: string; source: DownloadSource; fallback: Choice }[] = [];
    for (const t of listSongTracks(db, song.id)) {
      if (!t.current) continue;
      let choice = exportFormatOf(t.current, format);
      if (!choice) continue;
      let source: DownloadSource;
      try {
        source = await resolveDownload(ctx, t.current.version.id, choice.format);
      } catch (err) {
        // A file that cannot be rebuilt in this format: Opus, when there is one.
        if (!(err instanceof AppError) || choice.format === "opus") continue;
        choice = { format: "opus", fallback: "opus" };
        try {
          source = await resolveDownload(ctx, t.current.version.id, "opus");
        } catch {
          continue;
        }
      }
      files.push({ name: t.track.name, source, fallback: choice });
    }
    if (files.length === 0) continue;
    preview.songs++;
    const songName = zipPathSegment(song.title);
    const dir = files.length > 1 ? uniquePath(taken, `${root}/${songName}`) : null;
    for (const f of files) {
      const ext = extOf(f.source.filename);
      const name = dir
        ? uniquePath(taken, `${dir}/${zipPathSegment(f.name)}${ext}`)
        : uniquePath(taken, `${root}/${songName}${ext}`);
      entries.push({ name, size: f.source.size, source: f.source });
      if (f.fallback?.fallback === "opus") preview.opusFallbacks++;
      if (f.fallback?.fallback === "original") preview.originalFallbacks++;
    }
  }

  // Documents need the full view of the project and its download policy (SPEC §3.3, §10).
  if (access.visibility === "full" && documentDownloadAllowed(access)) {
    for (const doc of listDocuments(db, access.project.id)) {
      const v = doc.currentVersionId ? getDocumentVersionRow(db, doc.currentVersionId) : undefined;
      const asset = v && v.deletedAt === null ? getAsset(db, v.assetId) : undefined;
      const original = asset?.status === "ready" ? getVariant(db, asset.id, "original") : undefined;
      const blob = original && getBlob(db, original.blobHash);
      if (!asset || !original || !blob) continue;
      const ext = extOf(asset.originalFilename);
      const title = zipPathSegment(doc.title);
      const file = ext && title.toLowerCase().endsWith(ext) ? title : `${title}${ext}`;
      entries.push({
        name: uniquePath(taken, `${root}/Documents/${file}`),
        size: blob.sizeBytes,
        source: {
          kind: "blob",
          hash: original.blobHash,
          storageKey: blob.storageKey,
          size: blob.sizeBytes,
          filename: asset.originalFilename,
          contentType: "application/octet-stream",
        },
      });
      preview.documents++;
    }
  }
  preview.files = entries.length;
  preview.bytes = planZip(entries).totalSize;
  return { root, entries, preview };
}

/** The archive's entries, streaming each file when its turn comes. */
export function zipEntries(
  ctx: AppContext,
  plan: ExportPlan,
  log: FastifyRequest["log"],
): ZipEntry[] {
  return plan.entries.map((e) => ({
    name: e.name,
    size: e.size,
    open: (signal?: AbortSignal) => {
      const src = e.source;
      if (src.kind === "blob") return ctx.storage.getStream(src.storageKey);
      return streamWav(ctx, src, signal ?? new AbortController().signal, log).stream;
    },
  }));
}
