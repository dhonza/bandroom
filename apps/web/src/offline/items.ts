import type { OfflineQuality } from "@bandroom/shared";
import { itemKey, type OfflineItem } from "./db";

/** Offline items as pure data (SPEC §13): new items and what plays from them while offline. */

export function newItem(
  kind: OfflineItem["kind"],
  id: string,
  title: string,
  projectId: string,
  prefs: { quality: OfflineQuality; lossless: boolean },
  addedAt: number,
): OfflineItem {
  return {
    key: itemKey(kind, id),
    kind,
    id,
    title,
    projectId,
    addedAt,
    syncedAt: null,
    autoUpdate: true,
    quality: prefs.quality,
    lossless: prefs.lossless,
    status: "downloading",
    error: null,
    bytes: 0,
    blobs: [],
    urls: [],
    songIds: kind === "song" ? [id] : [],
  };
}

/** The offline item that holds a song, if any (song item first, else a project item). */
export function offlineItemFor(songId: string, items: readonly OfflineItem[]) {
  return (
    items.find((i) => i.kind === "song" && i.id === songId) ??
    items.find((i) => i.kind === "project" && i.songIds.includes(songId))
  );
}

/**
 * While offline, play the quality that is on this device: Opus (normal), Opus low (small), FLAC
 * only when it was downloaded too. Online (or without an offline copy) the resolved quality.
 */
export function offlineQualityFor<Q extends "lossless" | "high" | "low">(
  online: boolean,
  item: OfflineItem | undefined,
  resolved: Q,
): Q | "lossless" | "high" | "low" {
  if (online) return resolved;
  if (!item) return resolved;
  if (resolved === "lossless" && item.lossless) return "lossless";
  return item.quality === "small" ? "low" : "high";
}

/**
 * Whether a file can play now: always online; offline, when the song's offline copy holds it (a
 * song without an offline copy is left to the browser cache).
 */
export function playableFrom(online: boolean, item: OfflineItem | undefined, hash: string) {
  if (online) return true;
  return !item || item.blobs.includes(hash);
}
