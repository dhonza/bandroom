import {
  createComment,
  createMarker,
  deleteMarker,
  getProjectOfflineManifest,
  getSongOfflineManifest,
  listSongMarkers,
  putSongMixer,
  recordProjectOffline,
  recordSongOffline,
  updateMarker,
  uuidv7,
  type OfflineQuality,
} from "@bandroom/shared";
import { create } from "zustand";
import { api, ApiError } from "../api/client";
import { removeUserTakes } from "../record/opfs";
import { stopTakeWriter } from "../record/takeWriterClient";
import { stopTakes } from "../record/takes";
import {
  deleteOfflineDb,
  openOfflineDb,
  type OfflineDb,
  type OfflineItem,
  type OutboxEntry,
  type OutboxKind,
} from "./db";
import {
  newItem,
  offlineItemFor as findOfflineItem,
  offlineQualityFor,
  playableFrom,
} from "./items";
import { pinnedCacheName, blobCacheName, userCacheNames } from "./names";
import { isOnline, onReconnect } from "./online";
import { enqueueMixer, replayOutbox, type OutboxPayloads, type ReplayResult } from "./outbox";
import {
  checkItem,
  missingBytes,
  openCache,
  planFor,
  removeItem,
  syncItem,
  type SyncDeps,
} from "./sync";
import {
  blobCacheUrl,
  commentsPageUrl,
  documentUrls,
  globalUrls,
  projectUrls,
  songUrls,
} from "./urls";

export { deviceOfflinePrefs, setDeviceOfflinePrefs } from "./prefs";

/**
 * The logged-in user's offline data (SPEC §13): items, downloads, auto-update and the outbox.
 * One user at a time; all cache work runs one step after another.
 */
interface OfflineState {
  userId: string | null;
  items: OfflineItem[];
  outbox: OutboxEntry[];
  progress: Record<string, { done: number; total: number }>;
  /** `navigator.storage.persist()` result after the first download (null: not asked). */
  persisted: boolean | null;
  /** Result of the last outbox replay that sent or dropped something (for the summary toast). */
  lastReplay: (ReplayResult & { at: number; songIds: string[] }) | null;
  /** The last offline copy removed because the song or project was deleted on the server. */
  lastGone: { kind: OfflineItem["kind"]; title: string; at: number } | null;
}

export const useOffline = create<OfflineState>(() => ({
  userId: null,
  items: [],
  outbox: [],
  progress: {},
  persisted: null,
  lastReplay: null,
  lastGone: null,
}));

interface Session {
  userId: string;
  db: OfflineDb;
  deps: SyncDeps;
  timers: number[];
  unsubscribe: () => void;
}

let session: Session | null = null;
let chain: Promise<unknown> = Promise.resolve();

/** Runs cache work one step at a time (downloads, refreshes, removals, garbage collection). */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export const offlineSupported = () =>
  typeof window !== "undefined" && "caches" in window && "indexedDB" in window;

const q = (item: Pick<OfflineItem, "quality" | "lossless">) => ({
  quality: item.quality,
  lossless: item.lossless ? ("true" as const) : ("false" as const),
});

function buildDeps(db: OfflineDb, blobs: SyncDeps["blobs"], pinned: SyncDeps["pinned"]): SyncDeps {
  return {
    db,
    blobs,
    pinned,
    urls: {
      blob: blobCacheUrl,
      global: globalUrls,
      project: projectUrls,
      song: songUrls,
      document: documentUrls,
      commentsPage: commentsPageUrl,
    },
    fetch: (url, init) => fetch(url, init),
    songManifest: async (item) =>
      (await api(getSongOfflineManifest, { params: { id: item.id }, query: q(item) })).song,
    projectManifest: async (item) =>
      (await api(getProjectOfflineManifest, { params: { id: item.id }, query: q(item) })).project,
    now: () => Date.now(),
    onProgress: (key, done, total) => {
      useOffline.setState((s) => ({ progress: { ...s.progress, [key]: { done, total } } }));
    },
    onItem: (item) => {
      useOffline.setState((s) => ({
        items: [...s.items.filter((i) => i.key !== item.key), item],
        ...(item.status !== "downloading" && { progress: omit(s.progress, item.key) }),
      }));
    },
    // Deleted on the server (or no longer visible): the copy goes; network errors keep it.
    isGone: (err) => err instanceof ApiError && err.status === 404,
    onGone: (item) => {
      useOffline.setState((s) => ({
        items: s.items.filter((i) => i.key !== item.key),
        progress: omit(s.progress, item.key),
        lastGone: { kind: item.kind, title: item.title, at: Date.now() },
      }));
    },
  };
}

function omit<T>(rec: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).filter(([k]) => k !== key));
}

async function reload(s: Session): Promise<void> {
  const [items, outbox] = await Promise.all([s.db.items(), s.db.outbox()]);
  if (session === s) useOffline.setState({ items, outbox });
}

/** Opens the user's offline data and starts sync (on login / session load). */
export async function startOffline(userId: string): Promise<void> {
  if (session?.userId === userId || !offlineSupported()) return;
  stopOffline();
  const db = await openOfflineDb(userId);
  const [blobs, pinned] = await Promise.all([
    openCache(blobCacheName(userId)),
    openCache(pinnedCacheName(userId)),
  ]);
  const s: Session = {
    userId,
    db,
    deps: buildDeps(db, blobs, pinned),
    timers: [],
    unsubscribe: () => undefined,
  };
  session = s;
  useOffline.setState({ userId, items: [], outbox: [], progress: {}, lastReplay: null });
  await reload(s);
  // Downloads interrupted by closing the app continue.
  for (const item of useOffline.getState().items) {
    if (item.status === "downloading") void refreshItem(item.key);
  }
  const onlineWork = () => {
    void replayNow().then(() => refreshAll());
  };
  s.unsubscribe = onReconnect(onlineWork);
  s.timers.push(window.setInterval(() => void refreshAll(), 30 * 60_000));
  if (isOnline()) onlineWork();
}

export function stopOffline(): void {
  if (!session) return;
  session.unsubscribe();
  for (const t of session.timers) window.clearInterval(t);
  session.db.close();
  session = null;
  useOffline.setState({ userId: null, items: [], outbox: [], progress: {} });
}

function requireSession(): Session {
  if (!session) throw new Error("offline session not started");
  return session;
}

/** Size estimate before downloading (SPEC §13): total, and what is not on this device yet. */
export async function estimateOffline(
  kind: OfflineItem["kind"],
  id: string,
  prefs: { quality: OfflineQuality; lossless: boolean },
): Promise<{ bytes: number; missing: number; songs: number }> {
  const s = requireSession();
  const probe = newItem(kind, id, "", "", prefs, Date.now());
  const plan = await planFor(s.deps, probe);
  return {
    bytes: plan.bytes,
    missing: await missingBytes(s.deps, plan),
    songs: plan.songIds.length,
  };
}

async function requestPersistence(): Promise<void> {
  if (useOffline.getState().persisted !== null) return;
  try {
    const persisted = await navigator.storage.persist();
    useOffline.setState({ persisted });
  } catch {
    useOffline.setState({ persisted: false });
  }
}

/** "Make available offline" (SPEC §13). Resolves when the download finished (or failed). */
export async function makeAvailableOffline(
  kind: OfflineItem["kind"],
  id: string,
  title: string,
  projectId: string,
  prefs: { quality: OfflineQuality; lossless: boolean },
): Promise<OfflineItem | null> {
  const s = requireSession();
  const item = newItem(kind, id, title, projectId, prefs, Date.now());
  await s.db.putItem(item);
  s.deps.onItem?.(item);
  void requestPersistence();
  const done = await exclusive(() => syncItem(s.deps, item.key));
  if (done) {
    await enqueue("offline.event", kind === "song" ? id : null, {
      target: kind,
      id,
      body: { action: "added", bytes: done.bytes, quality: done.quality },
    });
    void replayNow();
  }
  return done;
}

export async function removeOffline(key: string): Promise<void> {
  const s = requireSession();
  const item = await s.db.getItem(key);
  await exclusive(() => removeItem(s.deps, key));
  await reload(s);
  if (item) {
    await enqueue("offline.event", item.kind === "song" ? item.id : null, {
      target: item.kind,
      id: item.id,
      body: { action: "removed", bytes: item.bytes, quality: item.quality },
    });
    void replayNow();
  }
}

export async function removeAllOffline(): Promise<void> {
  for (const item of useOffline.getState().items) await removeOffline(item.key);
}

export async function setAutoUpdate(key: string, autoUpdate: boolean): Promise<void> {
  const s = requireSession();
  const item = await s.db.getItem(key);
  if (!item) return;
  const next = { ...item, autoUpdate };
  await s.db.putItem(next);
  s.deps.onItem?.(next);
  if (autoUpdate && isOnline()) void refreshItem(key);
}

/** Downloads what changed now ("Update now", or auto-update). */
export function refreshItem(key: string): Promise<OfflineItem | null> {
  const s = requireSession();
  return exclusive(() => syncItem(s.deps, key));
}

/** Auto-update (SPEC §13): refresh items with auto-update on, check the others. */
export async function refreshAll(): Promise<void> {
  const s = session;
  if (!s || !isOnline()) return;
  for (const item of await s.db.items()) {
    if (session !== s || !isOnline()) return;
    await exclusive(() =>
      item.autoUpdate ? syncItem(s.deps, item.key) : checkItem(s.deps, item.key),
    );
  }
}

/** The offline item that holds a song, if any (song item first, else a project item). */
export function offlineItemFor(songId: string, items = useOffline.getState().items) {
  return findOfflineItem(songId, items);
}

/**
 * While offline, play the quality that is on this device (SPEC §13): Opus (normal), Opus low
 * (small), FLAC only when it was downloaded too.
 */
export function offlineQuality<Q extends "lossless" | "high" | "low">(
  songId: string,
  resolved: Q,
): Q | "lossless" | "high" | "low" {
  if (isOnline()) return resolved;
  return offlineQualityFor(false, offlineItemFor(songId), resolved);
}

/**
 * Whether a file of the song can play now: always online; offline, when the song's offline copy
 * holds it (a song without an offline copy is left to the browser cache).
 */
export function playableOffline(songId: string, hash: string): boolean {
  if (isOnline()) return true;
  return playableFrom(false, offlineItemFor(songId), hash);
}

// --- Outbox -------------------------------------------------------------------------------------

export async function enqueue<K extends OutboxKind>(
  kind: K,
  songId: string | null,
  payload: OutboxPayloads[K],
  requestId: string = uuidv7(),
): Promise<void> {
  const s = requireSession();
  await s.db.addOutbox({ requestId, kind, songId, createdAt: Date.now(), payload });
  await reload(s);
}

/** Replaces the song's pending mixer state (only the latest one is sent). */
export async function enqueueMixerState(
  songId: string,
  state: OutboxPayloads["mixer.put"]["state"],
): Promise<void> {
  const s = requireSession();
  await enqueueMixer(s.db, songId, state, uuidv7(), Date.now());
  await reload(s);
}

/** The user's offline database while the offline session runs (recorded takes, SPEC §9). */
export function offlineDb(): OfflineDb | null {
  return session?.db ?? null;
}

export function hasOfflineSession(): boolean {
  return session !== null;
}

/** A failed request that should wait for the network (vs. one the server rejected). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiError && (err.code === "NETWORK" || err.status >= 502);
}

/** A change that failed only for lack of network and can wait in the outbox (SPEC §13). */
export function shouldQueueOffline(err: unknown): boolean {
  return isNetworkError(err) && hasOfflineSession();
}

let replaying: Promise<void> | null = null;

/** Sends the outbox in order (SPEC §13); on reconnect, at start and after offline changes. */
export function replayNow(): Promise<void> {
  const s = session;
  if (!s || !isOnline()) return Promise.resolve();
  replaying ??= (async () => {
    try {
      if ((await s.db.outbox()).length === 0) return;
      const songIds = new Set<string>();
      const result = await replayOutbox({
        db: s.db,
        isNetworkError,
        // The song lock and an edit session (SPEC §24.7) both refuse the queued change.
        isSongLocked: (err) =>
          err instanceof ApiError && (err.code === "SONG_LOCKED" || err.code === "SONG_EDITING"),
        onSent: (e) => {
          if (e.songId) songIds.add(e.songId);
        },
        send: {
          createComment: async (songId, body) =>
            (await api(createComment, { params: { id: songId }, body })).comment,
          createMarker: async (songId, body) =>
            (await api(createMarker, { params: { id: songId }, body })).marker,
          listMarkers: async (songId) =>
            (await api(listSongMarkers, { params: { id: songId } })).markers,
          updateMarker: async (id, patch) => {
            await api(updateMarker, { params: { id }, body: patch });
          },
          deleteMarker: async (id) => {
            try {
              await api(deleteMarker, { params: { id } });
            } catch (err) {
              if (!(err instanceof ApiError && err.code === "NOT_FOUND")) throw err;
            }
          },
          putMixer: async (songId, state) => {
            await api(putSongMixer, { params: { id: songId }, body: { state } });
          },
          offlineEvent: async (target, id, body) => {
            await (target === "song"
              ? api(recordSongOffline, { params: { id }, body })
              : api(recordProjectOffline, { params: { id }, body }));
          },
        },
      });
      for (const d of result.dropped) if (d.songId) songIds.add(d.songId);
      await reload(s);
      if (result.sent > 0 || result.dropped.length > 0) {
        useOffline.setState({ lastReplay: { ...result, at: Date.now(), songIds: [...songIds] } });
      }
    } finally {
      replaying = null;
    }
  })();
  return replaying;
}

// --- Logout -------------------------------------------------------------------------------------

/** Deletes everything this device keeps for a user (SPEC §13: logout clears offline data). */
export async function clearOfflineData(userId: string): Promise<void> {
  // Recorded takes go too (SPEC §9; the logout prompt warned about unsent ones).
  stopTakes();
  stopTakeWriter();
  await removeUserTakes(userId);
  if (session?.userId === userId) stopOffline();
  if (typeof caches !== "undefined") {
    for (const name of userCacheNames(userId)) await caches.delete(name);
  }
  try {
    await deleteOfflineDb(userId);
  } catch {
    // blocked: removed when the last connection closes
  }
}
