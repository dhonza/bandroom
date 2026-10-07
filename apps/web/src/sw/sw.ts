/// <reference lib="webworker" />
import {
  API_CACHE_MAX_ENTRIES,
  CACHE_HIT_HEADER,
  apiCacheName,
  blobCacheName,
  FROM_CACHE_HEADER,
  pinnedCacheName,
  SHELL_CACHE_PREFIX,
  SYNC_HEADER,
} from "../offline/names";
import { readSwUser, writeSwUser } from "../offline/swState";
import { rangeResponse } from "./range";
import { classify, isSessionUrl } from "./routing";

/**
 * BandRoom service worker (SPEC §13): precaches the app shell so the app opens without network,
 * serves offline songs' blobs (Range-aware) and API responses from per-user caches when the
 * network is unavailable, and waits for the page's "reload" before a new version takes over.
 */

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[];
};

const MANIFEST = self.__WB_MANIFEST;
const SCOPE = self.registration.scope;

function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const SHELL_CACHE =
  SHELL_CACHE_PREFIX + hashString(MANIFEST.map((e) => `${e.url}@${e.revision ?? ""}`).join("|"));
/** The server-rendered index.html (with `<base href>` and the runtime config). */
const SHELL_URL = new URL("./", SCOPE).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const urls = [...new Set(MANIFEST.map((e) => new URL(e.url, SCOPE).href))];
      await cache.addAll(urls.map((u) => new Request(u, { cache: "reload" })));
      const index = await fetch(SHELL_URL, { cache: "no-store", credentials: "same-origin" });
      if (!index.ok) throw new Error(`app shell: HTTP ${index.status}`);
      await cache.put(SHELL_URL, index);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

let user: string | null | undefined;

async function currentUser(): Promise<string | null> {
  user ??= await readSwUser();
  return user;
}

async function setUser(id: string | null): Promise<void> {
  user = id;
  await writeSwUser(id);
}

self.addEventListener("message", (event) => {
  const data = event.data as { type?: string; userId?: string | null } | null;
  if (data?.type === "SKIP_WAITING") void self.skipWaiting();
  if (data?.type === "SET_USER") {
    const id = data.userId ?? null;
    event.waitUntil(setUser(id));
  }
});

self.addEventListener("fetch", (event) => {
  const kind = classify(event.request, SCOPE);
  if (kind === "bypass") return;
  if (kind === "navigate") event.respondWith(navigate(event.request));
  else if (kind === "static") event.respondWith(fromShell(event.request));
  else if (kind === "blob") event.respondWith(blob(event.request));
  else event.respondWith(apiRequest(event));
});

async function shellResponse(): Promise<Response | undefined> {
  return (await caches.open(SHELL_CACHE)).match(SHELL_URL);
}

async function navigate(request: Request): Promise<Response> {
  try {
    const res = await fetch(request);
    if (res.status < 502) return res;
    return (await shellResponse()) ?? res;
  } catch (err) {
    const shell = await shellResponse();
    if (shell) return shell;
    throw err;
  }
}

async function fromShell(request: Request): Promise<Response> {
  const hit = await (await caches.open(SHELL_CACHE)).match(request, { ignoreSearch: true });
  return hit ?? fetch(request);
}

async function blob(request: Request): Promise<Response> {
  const uid = await currentUser();
  if (uid !== null) {
    const hit = await (await caches.open(blobCacheName(uid))).match(request.url);
    if (hit) return rangeResponse(request, hit, { [CACHE_HIT_HEADER]: "1" });
  }
  return fetch(request);
}

async function lookup(uid: string, url: string): Promise<Response | undefined> {
  const opts = { ignoreVary: true };
  return (
    (await (await caches.open(pinnedCacheName(uid))).match(url, opts)) ??
    (await (await caches.open(apiCacheName(uid))).match(url, opts))
  );
}

let putsSincePrune = 0;

/** Keeps the latest response: in the pinned cache when an offline item holds it, else bounded. */
async function remember(uid: string, url: string, res: Response): Promise<void> {
  const pinned = await caches.open(pinnedCacheName(uid));
  if (await pinned.match(url, { ignoreVary: true })) {
    await pinned.put(url, res);
    return;
  }
  const runtime = await caches.open(apiCacheName(uid));
  await runtime.put(url, res);
  if (++putsSincePrune < 50) return;
  putsSincePrune = 0;
  const keys = await runtime.keys(); // insertion order: oldest first
  for (const k of keys.slice(0, Math.max(0, keys.length - API_CACHE_MAX_ENTRIES))) {
    await runtime.delete(k);
  }
}

async function apiRequest(event: FetchEvent): Promise<Response> {
  const request = event.request;
  const uid = await currentUser();
  let res: Response;
  try {
    res = await fetch(request);
  } catch (err) {
    const cached = uid === null ? undefined : await lookup(uid, request.url);
    if (cached) return rangeResponse(request, cached, { [FROM_CACHE_HEADER]: "1" });
    throw err;
  }
  if (res.status >= 502 && uid !== null) {
    // The proxy answers when the app is down: treat it like being offline.
    const cached = await lookup(uid, request.url);
    if (cached) return rangeResponse(request, cached, { [FROM_CACHE_HEADER]: "1" });
  }
  if (res.status !== 200 || request.headers.has("range") || request.headers.has(SYNC_HEADER)) {
    return res;
  }
  if (isSessionUrl(request.url, SCOPE)) {
    // Follow logins, logouts and expired sessions, and never file one user's data under another.
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { user?: { id?: string } | null } | null;
    const id = body?.user?.id ?? null;
    if (id !== uid) {
      const copy = res.clone();
      event.waitUntil(
        (async () => {
          await setUser(id);
          if (id !== null) await remember(id, request.url, copy);
        })(),
      );
      return res;
    }
  }
  if (uid !== null) event.waitUntil(remember(uid, request.url, res.clone()));
  return res;
}
