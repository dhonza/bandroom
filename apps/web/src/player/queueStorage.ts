import { z } from "zod";
import type { PlayQueue, RepeatMode } from "./queue";

/**
 * The play queue saved on this device (SPEC §6.10), per user: the songs (with what the
 * mini-player shows before anything loads), the position, the repeat mode and the source. Storage
 * can be missing or full (private mode): every access is guarded and failures are ignored.
 */

const EntrySchema = z.object({
  songId: z.string(),
  title: z.string(),
  subtitle: z.string(),
  ready: z.boolean(),
  projectId: z.string(),
  projectName: z.string(),
  imageHash: z.string().nullable(),
});

const SavedSchema = z.object({
  v: z.literal(1),
  queue: z.object({
    entries: z.array(EntrySchema).min(1),
    index: z.number().int().min(0),
    source: z.object({
      kind: z.enum(["project", "song", "mixed"]),
      projectId: z.string(),
      projectName: z.string(),
      imageHash: z.string().nullable(),
    }),
  }),
  repeat: z.enum(["off", "all", "one"]),
});

export interface SavedQueue {
  queue: PlayQueue;
  repeat: RepeatMode;
}

const PREFIX = "bandroom.queue.";

/** The signed-in user's key; null in a public link or before sign-in (nothing is saved). */
let currentKey: string | null = null;

export function setQueueStorageUser(userId: string | null): void {
  currentKey = userId === null ? null : `${PREFIX}${userId}`;
}

export function saveQueue(saved: SavedQueue): void {
  if (currentKey === null) return;
  try {
    localStorage.setItem(currentKey, JSON.stringify({ v: 1, ...saved }));
  } catch {
    // Storage full or blocked: the queue is just not kept.
  }
}

export function loadSavedQueue(): SavedQueue | null {
  if (currentKey === null) return null;
  try {
    const raw = localStorage.getItem(currentKey);
    if (raw === null) return null;
    const r = SavedSchema.safeParse(JSON.parse(raw));
    if (!r.success) return null;
    const { queue, repeat } = r.data;
    const index = Math.min(queue.index, queue.entries.length - 1);
    return { queue: { ...queue, index }, repeat };
  } catch {
    return null;
  }
}

/** The queue ended (✕, its end): it does not come back. */
export function forgetSavedQueue(): void {
  if (currentKey === null) return;
  try {
    localStorage.removeItem(currentKey);
  } catch {
    // Nothing to do.
  }
}
