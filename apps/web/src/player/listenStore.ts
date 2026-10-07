import type { ListenSource } from "@bandroom/shared";
import { create } from "zustand";

export interface QueueEntry {
  songId: string;
  title: string;
  subtitle: string;
  projectId: string;
  projectName: string;
  imageHash: string | null;
  listen: ListenSource | null;
}

export type ListenStatus = "idle" | "loading" | "playing" | "paused" | "error";
export type RepeatMode = "off" | "all" | "one";
export type ListenQuality = "high" | "low";

export interface ListenState {
  queue: QueueEntry[];
  index: number;
  status: ListenStatus;
  /** Seconds; updated from `timeupdate` (UI animates between updates via the engine clock). */
  position: number;
  duration: number;
  repeat: RepeatMode;
  quality: ListenQuality;
}

const QUALITY_KEY = "bandroom.listenQuality";

function storedQuality(): ListenQuality {
  try {
    return localStorage.getItem(QUALITY_KEY) === "low" ? "low" : "high";
  } catch {
    return "high";
  }
}

export function saveQuality(q: ListenQuality): void {
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {
    // per-device convenience only
  }
}

/** Listen-mode state (SPEC §6.10). The audio element lives in `listenEngine`. */
export const useListen = create<ListenState>(() => ({
  queue: [],
  index: 0,
  status: "idle",
  position: 0,
  duration: 0,
  repeat: "off",
  quality: storedQuality(),
}));

export function currentEntry(s: ListenState = useListen.getState()): QueueEntry | null {
  return s.queue[s.index] ?? null;
}

/** Entries that can actually play (processed audio available). */
export function isPlayable(e: QueueEntry): boolean {
  return e.listen?.status === "ready" && e.listen.opus !== null;
}

/** Next playable index in a direction, honoring repeat-all wrap-around; null at the end. */
export function nextPlayableIndex(
  queue: readonly QueueEntry[],
  from: number,
  dir: 1 | -1,
  wrap: boolean,
): number | null {
  const n = queue.length;
  for (let step = 1; step <= n; step++) {
    let i = from + dir * step;
    if (i < 0 || i >= n) {
      if (!wrap) return null;
      i = ((i % n) + n) % n;
    }
    const e = queue[i];
    if (e && isPlayable(e)) return i;
  }
  return null;
}
