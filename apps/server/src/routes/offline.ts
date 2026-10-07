import {
  getAsset,
  getBlob,
  getDocumentVersionRow,
  getMixerState,
  getTrackVersionRow,
  getVariant,
  listDocuments,
  listenSource,
  listSongTracks,
  listVariants,
  listVisibleSongs,
  projectImageHash,
  storeClientResponse,
  storedClientResponse,
  type Db,
  type DocumentRow,
  type ProjectRow,
  type SongRow,
  type TrackListVersion,
  versionDetails,
} from "@bandroom/server-core";
import {
  getProjectOfflineManifest,
  getSongOfflineManifest,
  hasCapability,
  recordProjectOffline,
  recordSongOffline,
  type EffectiveRole,
  type OfflineBlob,
  type OfflineDocument,
  type OfflineEvent,
  type OfflineQuality,
  type OfflineSongManifest,
} from "@bandroom/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";
import { downloadAllowed } from "../http/scope";

interface ManifestOptions {
  quality: OfflineQuality;
  lossless: boolean;
}

/** Variant names to cache for one track version (SPEC §13): Opus or Opus low, optional FLAC. */
export function offlineVariantNames(
  available: ReadonlySet<string>,
  { quality, lossless }: ManifestOptions,
): string[] {
  const out: string[] = [];
  const primary = quality === "small" ? "opus_low" : "opus";
  const fallback = quality === "small" ? "opus" : "opus_low";
  const opus = available.has(primary) ? primary : available.has(fallback) ? fallback : null;
  if (opus) out.push(opus, `seekindex_${opus}`);
  if (lossless && available.has("flac")) out.push("flac", "seekindex_flac");
  out.push("peaks");
  return out.filter((v) => available.has(v));
}

class Collector {
  private readonly seen = new Map<string, number>();

  constructor(private readonly db: Db) {}

  add(hash: string | null | undefined): void {
    if (!hash || this.seen.has(hash)) return;
    const blob = getBlob(this.db, hash);
    if (blob) this.seen.set(hash, blob.sizeBytes);
  }

  version(v: TrackListVersion, opts: ManifestOptions): void {
    if (v.asset.status !== "ready") return;
    const byName = new Map(v.variants.map((x) => [x.variant, x.blobHash]));
    for (const name of offlineVariantNames(new Set(byName.keys()), opts))
      this.add(byName.get(name));
  }

  get blobs(): OfflineBlob[] {
    return [...this.seen].map(([hash, bytes]) => ({ hash, bytes }));
  }
}

/** Current versions of documents: the viewer's file plus the WebP thumbnail and preview. */
function documentFiles(db: Db, docs: DocumentRow[], blobs: Collector): OfflineDocument[] {
  const out: OfflineDocument[] = [];
  for (const doc of docs) {
    const v = doc.currentVersionId ? getDocumentVersionRow(db, doc.currentVersionId) : null;
    if (!v || v.deletedAt !== null) continue;
    const asset = getAsset(db, v.assetId);
    if (!asset || asset.status !== "ready") continue;
    for (const x of listVariants(db, asset.id)) {
      if (x.variant === "webp_256" || x.variant === "webp_2048") blobs.add(x.blobHash);
    }
    const original = getVariant(db, asset.id, "original");
    const bytes = original ? (getBlob(db, original.blobHash)?.sizeBytes ?? 0) : 0;
    out.push({ documentId: doc.id, versionId: v.id, bytes });
  }
  return out;
}

/**
 * The manifest of one song. FLAC is included only when asked for and the user may download the
 * song's files (`role`, SPEC §3.4): lossless audio counts as a download. Besides each track's
 * current version it holds the version the user listens to instead in their saved mix
 * (`listenedVersionId`, DECISIONS 2026-10-03), when that version is still a version of the track.
 */
export function songOfflineManifest(
  db: Db,
  project: ProjectRow,
  song: SongRow,
  role: EffectiveRole,
  opts: ManifestOptions,
  userId: string,
): OfflineSongManifest {
  const blobs = new Collector(db);
  const tracks = listSongTracks(db, song.id);
  const lossless = opts.lossless && downloadAllowed({ project, song, role });
  const mix = getMixerState(db, userId, song.id);
  for (const t of tracks) {
    if (t.current) blobs.version(t.current, { ...opts, lossless });
    const listened = mix?.tracks[t.track.id]?.listenedVersionId;
    if (!listened || listened === t.current?.version.id) continue;
    // The saved mix is the user's own input: only a live version of this very track counts.
    const row = getTrackVersionRow(db, listened);
    const details = row?.trackId === t.track.id ? versionDetails(db, row) : null;
    if (details) blobs.version(details, { ...opts, lossless });
  }
  // Listen mode's mix (a mix-role track above, or the hidden automatic mix).
  const listen = listenSource(db, song.id);
  if (listen) blobs.version(listen.details, { ...opts, lossless: false });
  blobs.add(projectImageHash(db, project));
  const documents = documentFiles(db, listDocuments(db, project.id, song.id), blobs);
  return {
    songId: song.id,
    projectId: project.id,
    title: song.title,
    trackIds: tracks.map((t) => t.track.id),
    blobs: blobs.blobs,
    documents,
  };
}

/**
 * Offline manifests (SPEC §13): what a device must cache for a song or project, with sizes for the
 * estimate shown before downloading, and the `offline.added|removed` events per device.
 */
export function registerOfflineRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const options = (q: { quality: OfflineQuality; lossless: "true" | "false" }) => ({
    quality: q.quality,
    lossless: q.lossless === "true",
  });

  registerContract(app, getSongOfflineManifest, ({ access, query, user }) => ({
    song: songOfflineManifest(
      db,
      access.project,
      access.song,
      access.role,
      options(query),
      user.id,
    ),
  }));

  registerContract(app, getProjectOfflineManifest, ({ access, query, user }) => {
    const opts = options(query);
    const blobs = new Collector(db);
    blobs.add(projectImageHash(db, access.project));
    // Project documents need `viewer` on the project; the reduced view has none (SPEC §3.3).
    const documents =
      access.visibility === "full"
        ? documentFiles(db, listDocuments(db, access.project.id, null), blobs)
        : [];
    const songs = listVisibleSongs(db, user, access.project.id)
      .filter(({ role }) => hasCapability(role, "stream"))
      .map(({ song, role }) => songOfflineManifest(db, access.project, song, role, opts, user.id));
    return {
      project: {
        projectId: access.project.id,
        name: access.project.name,
        blobs: blobs.blobs,
        documents,
        songs,
      },
    };
  });

  const record = (
    request: FastifyRequest,
    userId: string,
    body: OfflineEvent,
    target: { projectId: string; songId: string | null; type: "song" | "project"; id: string },
  ) => {
    const route = "recordOffline";
    if (body.requestId && storedClientResponse(db, userId, body.requestId, route) !== undefined) {
      return { ok: true as const };
    }
    audit(db, request, {
      action: body.action === "added" ? "offline.added" : "offline.removed",
      projectId: target.projectId,
      songId: target.songId,
      targetType: target.type,
      targetId: target.id,
      details: { bytes: body.bytes, quality: body.quality },
    });
    const response = { ok: true as const };
    if (body.requestId) storeClientResponse(db, userId, body.requestId, route, response);
    return response;
  };

  registerContract(app, recordSongOffline, ({ access, body, user }, request) =>
    record(request, user.id, body, {
      projectId: access.project.id,
      songId: access.song.id,
      type: "song",
      id: access.song.id,
    }),
  );

  registerContract(app, recordProjectOffline, ({ access, body, user }, request) =>
    record(request, user.id, body, {
      projectId: access.project.id,
      songId: null,
      type: "project",
      id: access.project.id,
    }),
  );
}
