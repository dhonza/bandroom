/**
 * Names shared by the page and the service worker (SPEC §13). Offline data is namespaced per user
 * id, so logging out clears exactly one user's data and another user never sees it.
 */

/** App shell precache (one per build, older ones are deleted when a new worker activates). */
export const SHELL_CACHE_PREFIX = "bandroom-shell-";

/** Content-addressed blobs of offline songs, keyed by `…/api/v1/blobs/:hash`. */
export const blobCacheName = (userId: string) => `bandroom-blobs-${userId}`;

/** API responses of offline songs/projects (kept until the item is removed). */
export const pinnedCacheName = (userId: string) => `bandroom-pinned-${userId}`;

/** The latest response of every other API GET (bounded), for reading visited pages offline. */
export const apiCacheName = (userId: string) => `bandroom-api-${userId}`;

export const userCacheNames = (userId: string) => [
  blobCacheName(userId),
  pinnedCacheName(userId),
  apiCacheName(userId),
];

/** Requests made by the offline sync: the worker passes them through without caching them. */
export const SYNC_HEADER = "X-Bandroom-Sync";

/** Set on API responses the worker served from the offline cache (the network failed). */
export const FROM_CACHE_HEADER = "X-Bandroom-Offline";

/** Set on blobs the worker served from the offline blob cache. */
export const CACHE_HIT_HEADER = "X-Bandroom-Cache";

/** IndexedDB database of the worker's own state (the current user). */
export const SW_DB_NAME = "bandroom-sw";

/** IndexedDB database of one user's offline items and outbox. */
export const offlineDbName = (userId: string) => `bandroom-offline-${userId}`;

/** Most entries kept in the runtime API cache (oldest dropped first). */
export const API_CACHE_MAX_ENTRIES = 800;
