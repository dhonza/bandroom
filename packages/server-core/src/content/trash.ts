import type { TrashContainerKind, TrashKind, TrashListKind } from "@bandroom/shared";
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import {
  assets,
  assetVariants,
  blobs,
  documents,
  documentVersions,
  projects,
  settings,
  songs,
  tempoMapRevisions,
  tempoMaps,
  tracks,
  trackVersions,
  users,
} from "../db/schema";
import { removeAllVariants } from "../media/variants";
import type { ProjectRow, SongRow } from "./access";
import type { DocumentRow } from "./documents";
import { touchProject } from "./projects";
import { touchSongOfTrack, type TrackRow, type TrackVersionRow } from "./tracks";

// The Trash (SPEC §26.3): restore, list, and purge soft-deleted songs, tracks and versions, and
// deleted projects and documents.

export interface TrashIds {
  songs: readonly string[];
  tracks: readonly string[];
  versions: readonly string[];
  projects?: readonly string[];
  documents?: readonly string[];
}

/** A batch item resolved to its rows, whatever their state (SPEC §26.2). */
export interface ResolvedItem {
  kind: TrashKind;
  id: string;
  song: SongRow;
  project: ProjectRow;
  track: TrackRow | null;
  version: TrackVersionRow | null;
  /** The creator (songs, tracks) or uploader (versions), for the `.own` rules. */
  ownerId: string | null;
  /** Whether the item itself is in the Trash. */
  deleted: boolean;
}

/** Looks up a song, track or version with its song and project; items of deleted projects are not found. */
export function resolveItem(db: Db, kind: TrashKind, id: string): ResolvedItem | undefined {
  let version: TrackVersionRow | null = null;
  let track: TrackRow | null = null;
  let songId: string;
  if (kind === "version") {
    version = db.select().from(trackVersions).where(eq(trackVersions.id, id)).get() ?? null;
    if (!version) return undefined;
    track = db.select().from(tracks).where(eq(tracks.id, version.trackId)).get() ?? null;
    if (!track) return undefined;
    songId = track.songId;
  } else if (kind === "track") {
    track = db.select().from(tracks).where(eq(tracks.id, id)).get() ?? null;
    if (!track) return undefined;
    songId = track.songId;
  } else {
    songId = id;
  }
  const song = db.select().from(songs).where(eq(songs.id, songId)).get();
  const project =
    song &&
    db
      .select()
      .from(projects)
      .where(and(eq(projects.id, song.projectId), isNull(projects.deletedAt)))
      .get();
  if (!song || !project) return undefined;
  const row = version ?? track ?? song;
  return {
    kind,
    id,
    song,
    project,
    track,
    version,
    ownerId: version ? version.uploadedBy : (track ?? song).createdBy,
    deleted: row.deletedAt !== null,
  };
}

/** A deleted project or document resolved to its rows (SPEC §26.3). */
export interface ResolvedContainer {
  kind: TrashContainerKind;
  id: string;
  /** The project itself, or the document's project. */
  project: ProjectRow;
  /** A song document's song (in any state). */
  song: SongRow | null;
  document: DocumentRow | null;
  /** The creator, for the `.own` rules. */
  ownerId: string | null;
  deleted: boolean;
}

/**
 * Looks up a project (in any state) or a document. Documents of deleted projects are not found
 * (the project stands for them).
 */
export function resolveContainer(
  db: Db,
  kind: TrashContainerKind,
  id: string,
): ResolvedContainer | undefined {
  if (kind === "project") {
    const project = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!project) return undefined;
    const base = { kind, id, project, song: null, document: null, ownerId: project.createdBy };
    return { ...base, deleted: project.deletedAt !== null };
  }
  const document = db.select().from(documents).where(eq(documents.id, id)).get();
  if (!document) return undefined;
  const project = db
    .select()
    .from(projects)
    .where(and(eq(projects.id, document.projectId), isNull(projects.deletedAt)))
    .get();
  const song = document.songId
    ? (db.select().from(songs).where(eq(songs.id, document.songId)).get() ?? null)
    : null;
  if (!project || (document.songId !== null && !song)) return undefined;
  return {
    kind,
    id,
    project,
    song,
    document,
    ownerId: document.createdBy,
    deleted: document.deletedAt !== null,
  };
}

// --- Restore ------------------------------------------------------------------------------------

/** Restores a deleted project (admins, SPEC §26.3); its songs keep their own Trash state. */
export function restoreProjectRow(db: Db, projectId: string, now: number = Date.now()): ProjectRow {
  return db
    .update(projects)
    .set({ deletedAt: null, deletedBy: null, updatedAt: now })
    .where(eq(projects.id, projectId))
    .returning()
    .get();
}

export function restoreDocumentRow(db: Db, documentId: string): DocumentRow {
  return db
    .update(documents)
    .set({ deletedAt: null, deletedBy: null })
    .where(eq(documents.id, documentId))
    .returning()
    .get();
}

export function restoreSongRow(db: Db, songId: string, now: number = Date.now()): SongRow {
  const s = db
    .update(songs)
    .set({ deletedAt: null, deletedBy: null, updatedAt: now })
    .where(eq(songs.id, songId))
    .returning()
    .get();
  touchProject(db, s.projectId, now);
  return s;
}

export function restoreTrackRow(db: Db, trackId: string, now: number = Date.now()): TrackRow {
  const t = db
    .update(tracks)
    .set({ deletedAt: null, deletedBy: null })
    .where(eq(tracks.id, trackId))
    .returning()
    .get();
  touchSongOfTrack(db, t.songId, now);
  return t;
}

/**
 * Restores a version. It becomes current again when the track has none or the restored version
 * is newer than the current one (undoing the automatic choice made when it was deleted).
 * Returns whether the current version changed.
 */
export function restoreTrackVersionRow(
  db: Db,
  versionId: string,
  now: number = Date.now(),
): { version: TrackVersionRow; becameCurrent: boolean } {
  const v = db
    .update(trackVersions)
    .set({ deletedAt: null, deletedBy: null })
    .where(eq(trackVersions.id, versionId))
    .returning()
    .get();
  const track = db.select().from(tracks).where(eq(tracks.id, v.trackId)).get();
  if (!track) throw new Error("track missing");
  const current = track.currentVersionId
    ? db
        .select()
        .from(trackVersions)
        .where(and(eq(trackVersions.id, track.currentVersionId), isNull(trackVersions.deletedAt)))
        .get()
    : undefined;
  const becameCurrent = !current || current.number < v.number;
  if (becameCurrent) {
    db.update(tracks).set({ currentVersionId: v.id }).where(eq(tracks.id, track.id)).run();
  }
  touchSongOfTrack(db, track.songId, now);
  return { version: v, becameCurrent };
}

// --- Assets: references and sizes ---------------------------------------------------------------

/** Whether anything still points at the asset (versions and documents in the Trash count). */
export function assetReferenced(db: Db, assetId: string): boolean {
  const hit = (q: { get: () => unknown }) => q.get() !== undefined;
  if (
    hit(
      db
        .select({ x: trackVersions.id })
        .from(trackVersions)
        .where(eq(trackVersions.assetId, assetId))
        .limit(1),
    ) ||
    hit(
      db
        .select({ x: documentVersions.id })
        .from(documentVersions)
        .where(eq(documentVersions.assetId, assetId))
        .limit(1),
    ) ||
    hit(
      db
        .select({ x: tempoMaps.songId })
        .from(tempoMaps)
        .where(eq(tempoMaps.midiAssetId, assetId))
        .limit(1),
    ) ||
    hit(
      db
        .select({ x: tempoMapRevisions.id })
        .from(tempoMapRevisions)
        .where(eq(tempoMapRevisions.midiAssetId, assetId))
        .limit(1),
    ) ||
    hit(db.select({ x: projects.id }).from(projects).where(eq(projects.imageAssetId, assetId)))
  ) {
    return true;
  }
  const logo = db
    .select({ x: settings.key })
    .from(settings)
    .where(
      and(
        inArray(settings.key, ["branding.logoAssetId", "branding.logoPendingAssetId"]),
        eq(settings.value, JSON.stringify(assetId)),
      ),
    )
    .get();
  return logo !== undefined;
}

/**
 * Removes the variants (and the row) of every listed asset nothing references any more: the
 * uploaders' usage drops at once and the blobs become GC candidates. Returns the bytes taken off
 * the usage; the released blob hashes are added to `hashes` (for the purge's `blob.gc` job).
 */
export function releaseUnreferencedAssets(
  db: Db,
  assetIds: Iterable<string>,
  now: number = Date.now(),
  hashes?: Set<string>,
): number {
  let freed = 0;
  for (const id of new Set(assetIds)) {
    if (assetReferenced(db, id)) continue;
    freed += assetBytes(db, [id]);
    if (hashes)
      for (const r of db
        .select({ h: assetVariants.blobHash })
        .from(assetVariants)
        .where(eq(assetVariants.assetId, id))
        .all())
        hashes.add(r.h);
    removeAllVariants(db, id, now);
    db.delete(assets).where(eq(assets.id, id)).run();
  }
  return freed;
}

/** Sum of the stored variants of the assets (what their uploaders' usage counts, SPEC §15.1). */
function assetBytes(db: Db, assetIds: readonly string[]): number {
  if (assetIds.length === 0) return 0;
  return (
    db
      .select({ n: sql<number>`COALESCE(SUM(${blobs.sizeBytes}), 0)` })
      .from(assetVariants)
      .innerJoin(blobs, eq(blobs.hash, assetVariants.blobHash))
      .where(inArray(assetVariants.assetId, [...assetIds]))
      .get()?.n ?? 0
  );
}

/** Every version and document version inside an item, and the assets they and the song use. */
interface Subtree {
  versionIds: Set<string>;
  docVersionIds: Set<string>;
  assetIds: Set<string>;
}

function subtreeOf(db: Db, kind: TrashListKind, id: string): Subtree {
  const versionCols = { id: trackVersions.id, assetId: trackVersions.assetId };
  const versionRows =
    kind === "version"
      ? db.select(versionCols).from(trackVersions).where(eq(trackVersions.id, id)).all()
      : kind === "track"
        ? db.select(versionCols).from(trackVersions).where(eq(trackVersions.trackId, id)).all()
        : kind === "song"
          ? db
              .select(versionCols)
              .from(trackVersions)
              .innerJoin(tracks, eq(tracks.id, trackVersions.trackId))
              .where(eq(tracks.songId, id))
              .all()
          : kind === "project"
            ? db
                .select(versionCols)
                .from(trackVersions)
                .innerJoin(tracks, eq(tracks.id, trackVersions.trackId))
                .innerJoin(songs, eq(songs.id, tracks.songId))
                .where(eq(songs.projectId, id))
                .all()
            : [];
  const docCols = { id: documentVersions.id, assetId: documentVersions.assetId };
  const docWhere =
    kind === "song"
      ? eq(documents.songId, id)
      : kind === "project"
        ? eq(documents.projectId, id)
        : kind === "document"
          ? eq(documents.id, id)
          : undefined;
  const docRows = docWhere
    ? db
        .select(docCols)
        .from(documentVersions)
        .innerJoin(documents, eq(documents.id, documentVersions.documentId))
        .where(docWhere)
        .all()
    : [];
  // A song's (or a project's songs') tempo maps go with it.
  const songIds =
    kind === "song"
      ? [id]
      : kind === "project"
        ? db
            .select({ id: songs.id })
            .from(songs)
            .where(eq(songs.projectId, id))
            .all()
            .map((r) => r.id)
        : [];
  const midi =
    songIds.length > 0
      ? [
          ...db
            .select({ a: tempoMaps.midiAssetId })
            .from(tempoMaps)
            .where(and(inArray(tempoMaps.songId, songIds), isNotNull(tempoMaps.midiAssetId)))
            .all(),
          ...db
            .select({ a: tempoMapRevisions.midiAssetId })
            .from(tempoMapRevisions)
            .where(
              and(
                inArray(tempoMapRevisions.songId, songIds),
                isNotNull(tempoMapRevisions.midiAssetId),
              ),
            )
            .all(),
        ].flatMap((r) => (r.a ? [r.a] : []))
      : [];
  const image =
    kind === "project"
      ? (db.select({ a: projects.imageAssetId }).from(projects).where(eq(projects.id, id)).get()
          ?.a ?? null)
      : null;
  return {
    versionIds: new Set(versionRows.map((r) => r.id)),
    docVersionIds: new Set(docRows.map((r) => r.id)),
    assetIds: new Set(
      [...versionRows, ...docRows]
        .map((r) => r.assetId)
        .concat(midi)
        .concat(image ? [image] : []),
    ),
  };
}

/**
 * Storage an item would free when purged: the assets whose every reference lies inside the item
 * (copies share assets, SPEC §26.6, so a shared asset frees nothing).
 */
export function trashItemBytes(db: Db, kind: TrashListKind, id: string): number {
  return trashItemStorage(db, kind, id).bytes;
}

/**
 * {@link trashItemBytes}, and whether some of the item's files are shared with a copy (or another
 * use) and stay when it is purged, so a Trash row can say why it frees less than expected.
 */
export function trashItemStorage(
  db: Db,
  kind: TrashListKind,
  id: string,
): { bytes: number; shared: boolean } {
  const sub = subtreeOf(db, kind, id);
  const own = [...sub.assetIds].filter((assetId) => {
    const outsideVersion = db
      .select({ id: trackVersions.id })
      .from(trackVersions)
      .where(eq(trackVersions.assetId, assetId))
      .all()
      .some((r) => !sub.versionIds.has(r.id));
    const outsideDoc = db
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(eq(documentVersions.assetId, assetId))
      .all()
      .some((r) => !sub.docVersionIds.has(r.id));
    if (outsideVersion || outsideDoc) return false;
    if (kind !== "song" && kind !== "project") {
      // A song's own tempo maps go with it; for tracks and versions, any other use keeps it.
      const midi = db
        .select({ x: tempoMaps.songId })
        .from(tempoMaps)
        .where(eq(tempoMaps.midiAssetId, assetId))
        .get();
      if (midi) return false;
    }
    return true;
  });
  return { bytes: assetBytes(db, own), shared: own.length < sub.assetIds.size };
}

// --- Listing ------------------------------------------------------------------------------------

export interface TrashRow {
  kind: TrashListKind;
  id: string;
  name: string;
  number: number | null;
  /** Null for projects and project-level documents. */
  song: SongRow | null;
  project: ProjectRow;
  track: TrackRow | null;
  ownerId: string | null;
  deletedAt: number;
  deletedBy: { id: string; displayName: string } | null;
}

/**
 * Deleted songs, tracks, versions (not the hidden auto-mix) and documents, newest first; all
 * projects or one. Items of deleted projects are left out; the admin list (all projects) shows
 * the deleted projects themselves. Documents of a song in the Trash go with the song.
 */
export function listTrashRows(db: Db, projectId?: string): TrashRow[] {
  const allProjects = db
    .select()
    .from(projects)
    .where(projectId ? eq(projects.id, projectId) : undefined)
    .all();
  const projectRows = allProjects.filter((p) => p.deletedAt === null);
  const byProject = new Map(projectRows.map((p) => [p.id, p]));
  const names = new Map<string, string>();
  const nameOf = (userId: string | null) => {
    if (!userId) return null;
    let n = names.get(userId);
    if (n === undefined) {
      n =
        db.select({ n: users.displayName }).from(users).where(eq(users.id, userId)).get()?.n ?? "";
      names.set(userId, n);
    }
    return { id: userId, displayName: n };
  };
  const out: TrashRow[] = [];
  if (projectId === undefined) {
    for (const p of allProjects) {
      if (p.deletedAt === null) continue;
      out.push({
        kind: "project",
        id: p.id,
        name: p.name,
        number: null,
        song: null,
        project: p,
        track: null,
        ownerId: p.createdBy,
        deletedAt: p.deletedAt,
        deletedBy: nameOf(p.deletedBy),
      });
    }
  }
  if (byProject.size === 0) return out;
  const songRows = db
    .select()
    .from(songs)
    .where(inArray(songs.projectId, [...byProject.keys()]))
    .all();
  const songById = new Map(songRows.map((s) => [s.id, s]));
  const songIds = [...songById.keys()];
  for (const d of db
    .select()
    .from(documents)
    .where(and(inArray(documents.projectId, [...byProject.keys()]), isNotNull(documents.deletedAt)))
    .all()) {
    const project = byProject.get(d.projectId);
    const song = d.songId === null ? null : songById.get(d.songId);
    if (d.deletedAt === null || !project || song === undefined || song?.deletedAt != null) continue;
    out.push({
      kind: "document",
      id: d.id,
      name: d.title,
      number: null,
      song,
      project,
      track: null,
      ownerId: d.createdBy,
      deletedAt: d.deletedAt,
      deletedBy: nameOf(d.deletedBy),
    });
  }
  for (const s of songRows) {
    const project = byProject.get(s.projectId);
    if (s.deletedAt === null || !project) continue;
    out.push({
      kind: "song",
      id: s.id,
      name: s.title,
      number: null,
      song: s,
      project,
      track: null,
      ownerId: s.createdBy,
      deletedAt: s.deletedAt,
      deletedBy: nameOf(s.deletedBy),
    });
  }
  if (songIds.length === 0) return out.sort((a, b) => b.deletedAt - a.deletedAt);
  const trackRows = db.select().from(tracks).where(inArray(tracks.songId, songIds)).all();
  const trackById = new Map(trackRows.map((t) => [t.id, t]));
  for (const t of trackRows) {
    const song = songById.get(t.songId);
    const project = song && byProject.get(song.projectId);
    if (t.deletedAt === null || !song || !project) continue;
    out.push({
      kind: "track",
      id: t.id,
      name: t.name,
      number: null,
      song,
      project,
      track: t,
      ownerId: t.createdBy,
      deletedAt: t.deletedAt,
      deletedBy: nameOf(t.deletedBy),
    });
  }
  const trackIds = [...trackById.keys()];
  if (trackIds.length > 0) {
    const versionRows = db
      .select()
      .from(trackVersions)
      .where(and(inArray(trackVersions.trackId, trackIds), isNotNull(trackVersions.deletedAt)))
      .orderBy(desc(trackVersions.deletedAt))
      .all();
    for (const v of versionRows) {
      const track = trackById.get(v.trackId);
      const song = track && songById.get(track.songId);
      const project = song && byProject.get(song.projectId);
      if (v.deletedAt === null || !track || !song || !project) continue;
      out.push({
        kind: "version",
        id: v.id,
        name: v.label,
        number: v.number,
        song,
        project,
        track,
        ownerId: v.uploadedBy,
        deletedAt: v.deletedAt,
        deletedBy: nameOf(v.deletedBy),
      });
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

// --- Purge --------------------------------------------------------------------------------------

export interface PurgedItem {
  kind: TrashListKind;
  id: string;
  name: string;
  projectId: string;
  /** Null for projects and project-level documents. */
  songId: string | null;
}

/**
 * Deletes items permanently, in dependency order (SPEC §26.3): documents, versions, then tracks
 * (with their versions), then songs (with everything in them, by cascade), then projects (with
 * their songs, documents and image, by cascade). Then the assets nothing references
 * any more lose their variants, which lowers the usage at once; a `blob.gc` job (explicit purge)
 * or the daily blob GC deletes the files. Call inside a transaction. Returns what was purged, the
 * bytes taken off the usage and the blob hashes released (they may still be shared by others).
 */
export function purgeTrashItems(
  db: Db,
  ids: TrashIds,
  now: number = Date.now(),
): { purged: PurgedItem[]; bytesFreed: number; releasedHashes: string[] } {
  const purged: PurgedItem[] = [];
  const assetIds = new Set<string>();
  const collect = (kind: TrashKind, id: string) => {
    const item = resolveItem(db, kind, id);
    if (!item) return null;
    for (const a of subtreeOf(db, kind, id).assetIds) assetIds.add(a);
    purged.push({
      kind,
      id,
      name: item.version?.label ?? item.track?.name ?? item.song.title,
      projectId: item.project.id,
      songId: item.song.id,
    });
    return item;
  };
  const collectContainer = (kind: TrashContainerKind, id: string) => {
    const item = resolveContainer(db, kind, id);
    if (!item) return null;
    for (const a of subtreeOf(db, kind, id).assetIds) assetIds.add(a);
    purged.push({
      kind,
      id,
      name: item.document?.title ?? item.project.name,
      projectId: item.project.id,
      songId: item.song?.id ?? null,
    });
    return item;
  };
  const documentIds = (ids.documents ?? []).filter((id) => collectContainer("document", id));
  const versionIds = ids.versions.filter((id) => collect("version", id));
  const trackIds = ids.tracks.filter((id) => collect("track", id));
  const songIds = ids.songs.filter((id) => collect("song", id));
  const projectIds = (ids.projects ?? []).filter((id) => collectContainer("project", id));
  if (documentIds.length > 0) db.delete(documents).where(inArray(documents.id, documentIds)).run();
  if (versionIds.length > 0) {
    db.delete(trackVersions).where(inArray(trackVersions.id, versionIds)).run();
    // Defensive: a version in the Trash is never current, but no track may point at a gone one.
    db.update(tracks)
      .set({ currentVersionId: null })
      .where(inArray(tracks.currentVersionId, versionIds))
      .run();
  }
  if (trackIds.length > 0) db.delete(tracks).where(inArray(tracks.id, trackIds)).run();
  if (songIds.length > 0) db.delete(songs).where(inArray(songs.id, songIds)).run();
  if (projectIds.length > 0) db.delete(projects).where(inArray(projects.id, projectIds)).run();
  const hashes = new Set<string>();
  const bytesFreed = releaseUnreferencedAssets(db, assetIds, now, hashes);
  return { purged, bytesFreed, releasedHashes: [...hashes] };
}

/**
 * What the daily maintenance purges (SPEC §26.3): projects deleted before `cutoff`, and songs,
 * tracks, versions (including old auto-mix versions) and documents deleted before it in live
 * projects. Items inside an expired song are left to the song.
 */
export function expiredTrashIds(db: Db, cutoff: number): Required<TrashIds> {
  const liveProject = isNull(projects.deletedAt);
  const songIds = db
    .select({ id: songs.id })
    .from(songs)
    .innerJoin(projects, eq(projects.id, songs.projectId))
    .where(and(liveProject, lt(songs.deletedAt, cutoff)))
    .all()
    .map((r) => r.id);
  const expiredSongs = new Set(songIds);
  const trackIds = db
    .select({ id: tracks.id, songId: tracks.songId })
    .from(tracks)
    .innerJoin(songs, eq(songs.id, tracks.songId))
    .innerJoin(projects, eq(projects.id, songs.projectId))
    .where(and(liveProject, lt(tracks.deletedAt, cutoff)))
    .all()
    .filter((r) => !expiredSongs.has(r.songId))
    .map((r) => r.id);
  const expiredTracks = new Set(trackIds);
  const versionIds = db
    .select({ id: trackVersions.id, trackId: trackVersions.trackId, songId: tracks.songId })
    .from(trackVersions)
    .innerJoin(tracks, eq(tracks.id, trackVersions.trackId))
    .innerJoin(songs, eq(songs.id, tracks.songId))
    .innerJoin(projects, eq(projects.id, songs.projectId))
    .where(and(liveProject, lt(trackVersions.deletedAt, cutoff)))
    .all()
    .filter((r) => !expiredSongs.has(r.songId) && !expiredTracks.has(r.trackId))
    .map((r) => r.id);
  const documentIds = db
    .select({ id: documents.id, songId: documents.songId })
    .from(documents)
    .innerJoin(projects, eq(projects.id, documents.projectId))
    .where(and(liveProject, lt(documents.deletedAt, cutoff)))
    .all()
    .filter((r) => r.songId === null || !expiredSongs.has(r.songId))
    .map((r) => r.id);
  const projectIds = db
    .select({ id: projects.id })
    .from(projects)
    .where(lt(projects.deletedAt, cutoff))
    .all()
    .map((r) => r.id);
  return {
    songs: songIds,
    tracks: trackIds,
    versions: versionIds,
    documents: documentIds,
    projects: projectIds,
  };
}
