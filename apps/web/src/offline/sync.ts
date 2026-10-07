import type {
  OfflineBlob,
  OfflineDocument,
  OfflineProjectManifest,
  OfflineSongManifest,
} from "@bandroom/shared";
import type { OfflineDb, OfflineItem } from "./db";
import { SYNC_HEADER } from "./names";

/** The parts of Cache Storage the sync uses (a Map in tests). */
export interface CacheLike {
  match(url: string): Promise<Response | undefined>;
  put(url: string, res: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
  keys(): Promise<string[]>;
}

export async function openCache(name: string): Promise<CacheLike> {
  const c = await caches.open(name);
  return {
    match: (url) => c.match(url, { ignoreVary: true }),
    put: (url, res) => c.put(url, res),
    delete: (url) => c.delete(url, { ignoreVary: true }),
    keys: async () => (await c.keys()).map((r) => r.url),
  };
}

export function memoryCache(): CacheLike & { bodies: Map<string, Response> } {
  const bodies = new Map<string, Response>();
  return {
    bodies,
    match: (url) => Promise.resolve(bodies.get(url)?.clone()),
    put: async (url, res) => {
      const buf = await res.arrayBuffer();
      bodies.set(url, new Response(buf, { status: res.status, headers: res.headers }));
    },
    delete: (url) => Promise.resolve(bodies.delete(url)),
    keys: () => Promise.resolve([...bodies.keys()]),
  };
}

export interface UrlScheme {
  blob(hash: string): string;
  global(): string[];
  project(projectId: string): string[];
  song(song: OfflineSongManifest): string[];
  document(d: OfflineDocument): string[];
  commentsPage(songId: string, cursor?: string): string;
}

export interface SyncDeps {
  db: OfflineDb;
  blobs: CacheLike;
  pinned: CacheLike;
  urls: UrlScheme;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  songManifest(item: OfflineItem): Promise<OfflineSongManifest>;
  projectManifest(item: OfflineItem): Promise<OfflineProjectManifest>;
  now(): number;
  onProgress?(key: string, done: number, total: number): void;
  onItem?(item: OfflineItem): void;
  /**
   * Whether a manifest error means the song or project is gone on the server (deleted, or no
   * longer visible: 404). Network and other errors keep the copy.
   */
  isGone?(err: unknown): boolean;
  /** An item was removed because it is gone on the server (SPEC §13). */
  onGone?(item: OfflineItem): void;
}

/** What one offline item consists of, from its manifest. */
export interface SyncPlan {
  title: string;
  projectId: string;
  songIds: string[];
  blobs: OfflineBlob[];
  documents: OfflineDocument[];
  /** API responses to pin (without the comment pages, which are followed by cursor). */
  urls: string[];
  commentSongIds: string[];
  bytes: number;
}

function uniqueBlobs(list: OfflineBlob[]): OfflineBlob[] {
  const seen = new Map<string, OfflineBlob>();
  for (const b of list) if (!seen.has(b.hash)) seen.set(b.hash, b);
  return [...seen.values()];
}

export function planSong(m: OfflineSongManifest, urls: UrlScheme): SyncPlan {
  const blobs = uniqueBlobs(m.blobs);
  return {
    title: m.title,
    projectId: m.projectId,
    songIds: [m.songId],
    blobs,
    documents: m.documents,
    urls: [
      ...new Set([
        ...urls.global(),
        ...urls.project(m.projectId),
        ...urls.song(m),
        ...m.documents.flatMap((d) => urls.document(d)),
      ]),
    ],
    commentSongIds: [m.songId],
    bytes: sumBytes(blobs, m.documents),
  };
}

export function planProject(m: OfflineProjectManifest, urls: UrlScheme): SyncPlan {
  const blobs = uniqueBlobs([...m.blobs, ...m.songs.flatMap((s) => s.blobs)]);
  const documents = [...m.documents, ...m.songs.flatMap((s) => s.documents)];
  return {
    title: m.name,
    projectId: m.projectId,
    songIds: m.songs.map((s) => s.songId),
    blobs,
    documents,
    urls: [
      ...new Set([
        ...urls.global(),
        ...urls.project(m.projectId),
        ...m.songs.flatMap((s) => urls.song(s)),
        ...documents.flatMap((d) => urls.document(d)),
      ]),
    ],
    commentSongIds: m.songs.map((s) => s.songId),
    bytes: sumBytes(blobs, documents),
  };
}

function sumBytes(blobs: OfflineBlob[], docs: OfflineDocument[]): number {
  return blobs.reduce((n, b) => n + b.bytes, 0) + docs.reduce((n, d) => n + d.bytes, 0);
}

export async function planFor(deps: SyncDeps, item: OfflineItem): Promise<SyncPlan> {
  return item.kind === "song"
    ? planSong(await deps.songManifest(item), deps.urls)
    : planProject(await deps.projectManifest(item), deps.urls);
}

/** Bytes still to download for a plan (blobs already on this device are reused). */
export async function missingBytes(deps: Pick<SyncDeps, "blobs" | "urls">, plan: SyncPlan) {
  let n = plan.documents.reduce((s, d) => s + d.bytes, 0);
  for (const b of plan.blobs) if (!(await deps.blobs.match(deps.urls.blob(b.hash)))) n += b.bytes;
  return n;
}

export class SyncError extends Error {
  constructor(
    readonly code: "NETWORK" | "HTTP" | "STORAGE_FULL",
    message: string,
  ) {
    super(message);
  }
}

async function fetchOk(deps: SyncDeps, url: string, json: boolean): Promise<Response | null> {
  let res: Response;
  try {
    res = await deps.fetch(url, {
      credentials: "same-origin",
      headers: { [SYNC_HEADER]: "1", ...(json && { Accept: "application/json" }) },
    });
  } catch (err) {
    throw new SyncError("NETWORK", String(err));
  }
  // Optional parts the user cannot read (e.g. mention candidates) are skipped.
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new SyncError("HTTP", `HTTP ${res.status} for ${url}`);
  return res;
}

async function store(cache: CacheLike, url: string, res: Response): Promise<void> {
  try {
    await cache.put(url, res);
  } catch (err) {
    if (err instanceof DOMException && err.name === "QuotaExceededError") {
      throw new SyncError("STORAGE_FULL", "Storage is full");
    }
    throw err;
  }
}

/** Downloads missing blobs (two at a time) and reports progress in bytes. */
async function downloadBlobs(deps: SyncDeps, key: string, plan: SyncPlan): Promise<void> {
  const total = plan.bytes;
  let done = 0;
  const queue: OfflineBlob[] = [];
  for (const b of plan.blobs) {
    if (await deps.blobs.match(deps.urls.blob(b.hash))) done += b.bytes;
    else queue.push(b);
  }
  deps.onProgress?.(key, done, total);
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const url = deps.urls.blob(b.hash);
      const res = await fetchOk(deps, url, false);
      if (!res) throw new SyncError("HTTP", `No access to ${url}`);
      await store(deps.blobs, url, res);
      done += b.bytes;
      deps.onProgress?.(key, done, total);
    }
  };
  await Promise.all([worker(), worker()]);
}

/** Fetches and pins the API responses, following comment pages. Returns every pinned URL. */
async function pinResponses(deps: SyncDeps, plan: SyncPlan): Promise<string[]> {
  const pinned: string[] = [];
  for (const url of plan.urls) {
    const res = await fetchOk(deps, url, true);
    if (!res) continue;
    await store(deps.pinned, url, res);
    pinned.push(url);
  }
  for (const songId of plan.commentSongIds) {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = deps.urls.commentsPage(songId, cursor);
      const res = await fetchOk(deps, url, true);
      if (!res) break;
      const body = (await res
        .clone()
        .json()
        .catch(() => null)) as { nextCursor?: string | null } | null;
      await store(deps.pinned, url, res);
      pinned.push(url);
      if (!body?.nextCursor) break;
      cursor = body.nextCursor;
    }
  }
  return pinned;
}

/** Deletes cached blobs and responses no offline item holds any more. */
export async function collectGarbage(deps: Pick<SyncDeps, "db" | "blobs" | "pinned" | "urls">) {
  const items = await deps.db.items();
  const blobs = new Set(items.flatMap((i) => i.blobs.map((h) => deps.urls.blob(h))));
  const urls = new Set(items.flatMap((i) => i.urls));
  for (const k of await deps.blobs.keys()) if (!blobs.has(k)) await deps.blobs.delete(k);
  for (const k of await deps.pinned.keys()) if (!urls.has(k)) await deps.pinned.delete(k);
}

async function save(deps: SyncDeps, item: OfflineItem): Promise<void> {
  await deps.db.putItem(item);
  deps.onItem?.(item);
}

/**
 * Downloads or refreshes one item (SPEC §13 sync): new files first, then fresh API responses; the
 * files of versions that are no longer current are dropped only after that completed. On failure
 * the previous copy stays usable and the item shows the error.
 */
export async function syncItem(deps: SyncDeps, key: string): Promise<OfflineItem | null> {
  const start = await deps.db.getItem(key);
  if (!start) return null;
  await save(deps, { ...start, status: "downloading", error: null });
  try {
    const plan = await planFor(deps, start);
    await downloadBlobs(deps, key, plan);
    const urls = await pinResponses(deps, plan);
    const current = await deps.db.getItem(key);
    if (!current) {
      // Removed while downloading.
      await collectGarbage(deps);
      return null;
    }
    const done: OfflineItem = {
      ...current,
      title: plan.title,
      projectId: plan.projectId,
      songIds: plan.songIds,
      status: "ready",
      error: null,
      syncedAt: deps.now(),
      bytes: plan.bytes,
      blobs: plan.blobs.map((b) => b.hash),
      urls,
    };
    await save(deps, done);
    await collectGarbage(deps);
    return done;
  } catch (err) {
    const current = await deps.db.getItem(key);
    if (!current) return null;
    if (await removeIfGone(deps, current, err)) return null;
    const code = err instanceof SyncError ? err.code : "UNKNOWN";
    await save(deps, { ...current, status: "error", error: code });
    return null;
  }
}

/** Auto-update off: only tells whether the server has newer files (status `outdated`). */
export async function checkItem(deps: SyncDeps, key: string): Promise<OfflineItem | null> {
  const item = await deps.db.getItem(key);
  if (!item || item.status === "downloading") return item ?? null;
  let plan: SyncPlan;
  try {
    plan = await planFor(deps, item);
  } catch (err) {
    return (await removeIfGone(deps, item, err)) ? null : item;
  }
  const held = new Set(item.blobs);
  const changed =
    plan.blobs.length !== held.size ||
    plan.blobs.some((b) => !held.has(b.hash)) ||
    plan.documents.some((d) => !item.urls.includes(deps.urls.document(d).at(-1) ?? ""));
  const next: OfflineItem = { ...item, status: changed ? "outdated" : "ready" };
  if (next.status !== item.status) await save(deps, next);
  return next;
}

/** Removes the offline copy of a song or project the server no longer has (SPEC §13). */
async function removeIfGone(deps: SyncDeps, item: OfflineItem, err: unknown): Promise<boolean> {
  if (!deps.isGone?.(err)) return false;
  await removeItem(deps, item.key);
  deps.onGone?.(item);
  return true;
}

/** Removes an item and whatever only it held. */
export async function removeItem(deps: SyncDeps, key: string): Promise<void> {
  await deps.db.deleteItem(key);
  await collectGarbage(deps);
}
