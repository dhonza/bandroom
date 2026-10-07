import {
  getDocument,
  getMeta,
  getProject,
  getProjectFollow,
  getProjectQueue,
  getSession,
  getSong,
  getSongFollow,
  getSongListen,
  getSongMixer,
  getSongTempo,
  listDocumentVersions,
  listMentionableUsers,
  listProjectDocuments,
  listProjects,
  listProjectSongs,
  listSongComments,
  listSongDocuments,
  listSongMarkers,
  listSongTracks,
  listTrackVersions,
  type OfflineDocument,
  type OfflineSongManifest,
} from "@bandroom/shared";
import { contractUrl } from "../api/client";
import { apiUrl, blobUrl } from "../lib/media";

/** Absolute URLs, the keys of the offline caches (the service worker looks requests up by URL). */
const abs = (path: string) => new URL(path, window.location.origin).href;

export function blobCacheUrl(hash: string): string {
  return abs(blobUrl(hash));
}

export function contentCacheUrl(versionId: string): string {
  return abs(apiUrl(`/document-versions/${versionId}/content`));
}

export function commentsPageUrl(songId: string, cursor?: string): string {
  return abs(contractUrl(listSongComments, { params: { id: songId }, query: { cursor } }));
}

/** What the app shell needs to open offline at all: the session, instance meta, the library. */
export function globalUrls(): string[] {
  return [
    contractUrl(getSession),
    contractUrl(getMeta),
    contractUrl(listProjects, { query: { archived: "false" } }),
  ].map(abs);
}

/** The project page (header, songs, "Play all" queue, documents tab). */
export function projectUrls(projectId: string): string[] {
  const p = { params: { id: projectId } };
  return [
    contractUrl(getProject, p),
    contractUrl(listProjectSongs, p),
    contractUrl(getProjectQueue, p),
    contractUrl(listProjectDocuments, p),
    contractUrl(getProjectFollow, p),
  ].map(abs);
}

/**
 * Every request the song page makes for one song (SPEC §13 "timeline JSON"): the song, tracks and
 * version stacks, Listen source, markers/sections, tempo map, personal mixer, documents, follow
 * state and mention candidates. Comments are paged and added by the sync.
 */
export function songUrls(song: Pick<OfflineSongManifest, "songId" | "trackIds">): string[] {
  const p = { params: { id: song.songId } };
  return [
    contractUrl(getSong, p),
    contractUrl(listSongTracks, p),
    contractUrl(getSongListen, p),
    contractUrl(listSongMarkers, p),
    contractUrl(getSongTempo, p),
    contractUrl(getSongMixer, p),
    contractUrl(listSongDocuments, p),
    contractUrl(getSongFollow, p),
    contractUrl(listMentionableUsers, p),
    ...song.trackIds.map((id) => contractUrl(listTrackVersions, { params: { id } })),
  ].map(abs);
}

/** A document's page and viewer file. */
export function documentUrls(d: OfflineDocument): string[] {
  const p = { params: { id: d.documentId } };
  return [
    abs(contractUrl(getDocument, p)),
    abs(contractUrl(listDocumentVersions, p)),
    contentCacheUrl(d.versionId),
  ];
}
