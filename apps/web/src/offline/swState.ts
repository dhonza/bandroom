import { openDB, type IDBPDatabase } from "idb";
import { SW_DB_NAME } from "./names";

/**
 * The user whose offline data the service worker may serve, persisted in IndexedDB so a restarted
 * worker still knows it. Written by the page (login, session load, logout) and by the worker when
 * it sees the session endpoint's answer. `null`: nobody, serve nothing from user caches.
 */
let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(SW_DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore("kv");
    },
  });
  return dbPromise;
}

export async function readSwUser(): Promise<string | null> {
  try {
    const v: unknown = await (await db()).get("kv", "user");
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function writeSwUser(userId: string | null): Promise<void> {
  try {
    const d = await db();
    if (userId === null) await d.delete("kv", "user");
    else await d.put("kv", userId, "user");
  } catch {
    // IndexedDB unavailable (private mode): the worker then serves nothing from user caches
  }
}
