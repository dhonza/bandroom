import { linkShowsVersion } from "@bandroom/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/connection";
import { assetVariants, songs, tracks, trackVersions } from "../../db/schema";
import { getProjectRow, getSongRow, type ProjectRow, type SongRow } from "../access";
import { DOWNLOAD_ONLY_VARIANTS } from "../blobAccess";
import {
  listSongTracks,
  listTrackVersions,
  type TrackListItem,
  type TrackListVersion,
  type TrackRow,
  type TrackVersionRow,
} from "../tracks";
import { linkPolicyOf, type LinkRow } from "./core";
import { visibleVersion } from "../visibleVersions";

/** The live project of a link (undefined when it was deleted). */
export function linkProject(db: Db, link: LinkRow): ProjectRow | undefined {
  return getProjectRow(db, link.projectId);
}

/** A live song inside the link's scope. */
export function linkSong(db: Db, link: LinkRow, songId: string): SongRow | undefined {
  if (link.songId !== null && link.songId !== songId) return undefined;
  const song = getSongRow(db, songId);
  return song && song.projectId === link.projectId ? song : undefined;
}

/** Songs a link covers, in project order. */
export function linkSongs(db: Db, link: LinkRow): SongRow[] {
  if (link.songId !== null) {
    const s = linkSong(db, link, link.songId);
    return s ? [s] : [];
  }
  return db
    .select()
    .from(songs)
    .where(and(eq(songs.projectId, link.projectId), isNull(songs.deletedAt)))
    .orderBy(asc(songs.sortOrder), asc(songs.createdAt))
    .all();
}

function shows(link: LinkRow, track: TrackRow, versionId: string): boolean {
  return linkShowsVersion(linkPolicyOf(link), {
    versionId,
    isCurrent: track.currentVersionId === versionId,
  });
}

/**
 * Tracks of a song as the link shows them: `versions` links keep tracks with listed versions and
 * show a listed version as current. Version counts only count visible versions.
 */
export function linkVisibleTracks(db: Db, link: LinkRow, songId: string): TrackListItem[] {
  const out: TrackListItem[] = [];
  for (const item of listSongTracks(db, songId)) {
    const visible = linkVisibleVersions(db, link, item.track);
    if (visible.length === 0) continue;
    const current =
      visible.find((v) => v.version.id === item.track.currentVersionId) ?? visible[0] ?? null;
    out.push({ track: item.track, current, versionCount: visible.length });
  }
  return out;
}

/**
 * Visible versions per track (track id → version ids) of a song as the link shows it; used to
 * strip hidden tracks and versions from comment contexts (review L6).
 */
export function linkVisibleVersionSet(
  db: Db,
  link: LinkRow,
  songId: string,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const item of listSongTracks(db, songId)) {
    const ids = linkVisibleVersions(db, link, item.track).map((v) => v.version.id);
    if (ids.length > 0) out.set(item.track.id, new Set(ids));
  }
  return out;
}

/** Visible versions of one track, in stack order. */
export function linkVisibleVersions(db: Db, link: LinkRow, track: TrackRow): TrackListVersion[] {
  return listTrackVersions(db, track.id).filter((v) => shows(link, track, v.version.id));
}

export interface VersionLocation {
  version: TrackVersionRow;
  track: TrackRow;
}

function locateVersion(db: Db, versionId: string): VersionLocation | undefined {
  const row = db
    .select({ version: trackVersions, track: tracks })
    .from(trackVersions)
    .innerJoin(tracks, eq(tracks.id, trackVersions.trackId))
    .where(and(eq(trackVersions.id, versionId), visibleVersion(), isNull(tracks.deletedAt)))
    .get();
  return row;
}

/** A visible track version of a song covered by the link. */
export function linkVersion(
  db: Db,
  link: LinkRow,
  versionId: string,
): (VersionLocation & { song: SongRow }) | undefined {
  const loc = locateVersion(db, versionId);
  const song = loc && linkSong(db, link, loc.track.songId);
  if (!loc || !song || !shows(link, loc.track, versionId)) return undefined;
  return { ...loc, song };
}

/** A track of a covered song with at least one visible version. */
export function linkTrack(
  db: Db,
  link: LinkRow,
  trackId: string,
): { track: TrackRow; song: SongRow } | undefined {
  const track = db
    .select()
    .from(tracks)
    .where(and(eq(tracks.id, trackId), isNull(tracks.deletedAt)))
    .get();
  const song = track && linkSong(db, link, track.songId);
  if (!track || !song || linkVisibleVersions(db, link, track).length === 0) return undefined;
  return { track, song };
}

/**
 * Whether a link session may fetch a blob (SPEC §18.3): a variant of a visible track version of
 * a covered song, or the image of the link's project. Documents are not shared through links.
 * Lossless variants (`DOWNLOAD_ONLY_VARIANTS`) also need `mayDownload(songId)` (SPEC §3.4).
 * Returns the variant name, or null when not covered.
 */
export function linkCoversBlob(
  db: Db,
  link: LinkRow,
  hash: string,
  mayDownload: (songId: string) => boolean,
): string | null {
  const variants = db
    .select({ assetId: assetVariants.assetId, variant: assetVariants.variant })
    .from(assetVariants)
    .where(eq(assetVariants.blobHash, hash))
    .all();
  const project = linkProject(db, link);
  if (!project) return null;
  for (const v of variants) {
    if (project.imageAssetId === v.assetId) return v.variant;
    const versions = db
      .select({ id: trackVersions.id, songId: tracks.songId })
      .from(trackVersions)
      .innerJoin(tracks, eq(tracks.id, trackVersions.trackId))
      .where(and(eq(trackVersions.assetId, v.assetId), visibleVersion()))
      .all();
    const restricted = DOWNLOAD_ONLY_VARIANTS.has(v.variant);
    const covered = versions.some(
      (x) => linkVersion(db, link, x.id) !== undefined && (!restricted || mayDownload(x.songId)),
    );
    if (covered) return v.variant;
  }
  return null;
}
