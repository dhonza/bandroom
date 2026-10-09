import type { OfflineQuality, UploadTarget } from "@bandroom/shared";
import { deleteDB, openDB, type IDBPDatabase } from "idb";
import { offlineDbName } from "./names";

/** A song or project made available offline on this device (SPEC §13). */
export interface OfflineItem {
  /** `song:<id>` or `project:<id>`. */
  key: string;
  kind: "song" | "project";
  id: string;
  title: string;
  projectId: string;
  addedAt: number;
  /** Last completed download or refresh. */
  syncedAt: number | null;
  /** Refresh automatically when online (default on). */
  autoUpdate: boolean;
  quality: OfflineQuality;
  lossless: boolean;
  /**
   * `downloading` (first download or refresh running), `ready`, `outdated` (auto-update off and
   * the server has newer files), `error` (last attempt failed; the previous copy still works).
   */
  status: "downloading" | "ready" | "outdated" | "error";
  error: string | null;
  /** Bytes of the files this item holds (blobs + document files). */
  bytes: number;
  /** Blob hashes held in the blob cache. */
  blobs: string[];
  /** API URLs held in the pinned cache. */
  urls: string[];
  /** Songs covered (one for a song item). */
  songIds: string[];
}

export type OutboxKind =
  | "comment.create"
  | "marker.create"
  | "marker.update"
  | "marker.delete"
  | "mixer.put"
  | "offline.event";

/** A change made while offline, replayed in order when online (SPEC §13 outbox). */
export interface OutboxEntry {
  seq?: number;
  /** Client UUID; the server deduplicates replays by it (SPEC §18.3). */
  requestId: string;
  kind: OutboxKind;
  songId: string | null;
  createdAt: number;
  payload: unknown;
}

/**
 * A recorded take the user saved that has not been uploaded yet (SPEC §9): the audio stays in
 * OPFS (`takes/<userId>/<takeId>.flac`); this is what to upload it as.
 */
export interface PendingTake {
  takeId: string;
  userId: string;
  createdAt: number;
  savedAt: number;
  /** File name sent with the upload. */
  filename: string;
  bytes: number;
  frames: number;
  channels: number;
  /** Where it goes (`source: "recording"`, `offsetSamples`, the upload options). */
  target: UploadTarget;
  songId: string | null;
  projectId: string;
  /** The version label, set after the upload. */
  label: string;
  /** What the row shows: the track name, or the new song's title. */
  title: string;
  /** `waiting` (offline or not tried), `uploading`, `error` (the server refused it). */
  status: "waiting" | "uploading" | "error";
  errorCode: string | null;
}

/** Storage of one user's offline metadata; IndexedDB in the browser, a Map in tests. */
export interface OfflineDb {
  items(): Promise<OfflineItem[]>;
  getItem(key: string): Promise<OfflineItem | undefined>;
  putItem(item: OfflineItem): Promise<void>;
  deleteItem(key: string): Promise<void>;
  outbox(): Promise<OutboxEntry[]>;
  addOutbox(entry: OutboxEntry): Promise<number>;
  putOutbox(entry: OutboxEntry): Promise<void>;
  deleteOutbox(seq: number): Promise<void>;
  takes(): Promise<PendingTake[]>;
  putTake(take: PendingTake): Promise<void>;
  deleteTake(takeId: string): Promise<void>;
  close(): void;
}

export function itemKey(kind: OfflineItem["kind"], id: string): string {
  return `${kind}:${id}`;
}

/** v1: items and outbox; v2: recorded takes. */
export const DB_VERSION = 2;

export async function openOfflineDb(userId: string): Promise<OfflineDb> {
  const db: IDBPDatabase = await openDB(offlineDbName(userId), DB_VERSION, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore("items", { keyPath: "key" });
        d.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
      }
      // v2 (M12): recorded takes waiting for their upload.
      if (oldVersion < 2) d.createObjectStore("takes", { keyPath: "takeId" });
    },
  });
  return {
    items: () => db.getAll("items") as Promise<OfflineItem[]>,
    getItem: (key) => db.get("items", key) as Promise<OfflineItem | undefined>,
    putItem: async (item) => {
      await db.put("items", item);
    },
    deleteItem: (key) => db.delete("items", key),
    outbox: () => db.getAll("outbox") as Promise<OutboxEntry[]>,
    addOutbox: async (entry) => {
      const copy = { ...entry };
      delete copy.seq;
      return (await db.add("outbox", copy)) as number;
    },
    putOutbox: async (entry) => {
      await db.put("outbox", entry);
    },
    deleteOutbox: (seq) => db.delete("outbox", seq),
    takes: () => db.getAll("takes") as Promise<PendingTake[]>,
    putTake: async (take) => {
      await db.put("takes", take);
    },
    deleteTake: (takeId) => db.delete("takes", takeId),
    close: () => {
      db.close();
    },
  };
}

export async function deleteOfflineDb(userId: string): Promise<void> {
  await deleteDB(offlineDbName(userId));
}

/** In-memory `OfflineDb` for tests. */
export function memoryOfflineDb(): OfflineDb {
  const items = new Map<string, OfflineItem>();
  const outbox = new Map<number, OutboxEntry>();
  const takes = new Map<string, PendingTake>();
  let seq = 0;
  const clone = <T>(x: T): T => structuredClone(x);
  return {
    items: () => Promise.resolve([...items.values()].map(clone)),
    getItem: (key) => Promise.resolve(items.has(key) ? clone(items.get(key)) : undefined),
    putItem: (item) => {
      items.set(item.key, clone(item));
      return Promise.resolve();
    },
    deleteItem: (key) => {
      items.delete(key);
      return Promise.resolve();
    },
    outbox: () =>
      Promise.resolve([...outbox.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map(clone)),
    addOutbox: (entry) => {
      seq += 1;
      outbox.set(seq, { ...clone(entry), seq });
      return Promise.resolve(seq);
    },
    putOutbox: (entry) => {
      if (entry.seq !== undefined) outbox.set(entry.seq, clone(entry));
      return Promise.resolve();
    },
    deleteOutbox: (s) => {
      outbox.delete(s);
      return Promise.resolve();
    },
    takes: () =>
      Promise.resolve([...takes.values()].sort((a, b) => a.savedAt - b.savedAt).map(clone)),
    putTake: (take) => {
      takes.set(take.takeId, clone(take));
      return Promise.resolve();
    },
    deleteTake: (takeId) => {
      takes.delete(takeId);
      return Promise.resolve();
    },
    close: () => undefined,
  };
}
