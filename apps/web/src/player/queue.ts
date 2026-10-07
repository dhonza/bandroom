/**
 * The engine's play queue (SPEC §6.10): pure logic, kept free of the engine and React so it can
 * be tested in Node. The controller holds one queue in its store.
 */

export interface QueueEntry {
  songId: string;
  title: string;
  subtitle: string;
  /** Has audio ready to play (`getProjectQueue`'s `ready`). */
  ready: boolean;
}

/** Where the queue comes from: a project ("Play all", a song row) or one song page. */
export interface QueueSource {
  kind: "project" | "song";
  projectId: string;
  projectName: string;
  imageHash: string | null;
}

export interface PlayQueue {
  entries: QueueEntry[];
  index: number;
  source: QueueSource;
}

/** Songs that were deleted: by id, or every song of a deleted project. */
export interface GoneSongs {
  songIds?: readonly string[];
  projectId?: string;
}

export function currentEntry(q: PlayQueue | null): QueueEntry | null {
  return q?.entries[q.index] ?? null;
}

/** The next ready entry from `from` in a direction (not counting `from`); null at the end. */
export function nextReadyIndex(
  entries: readonly QueueEntry[],
  from: number,
  dir: 1 | -1,
): number | null {
  for (let i = from + dir; i >= 0 && i < entries.length; i += dir) {
    if (entries[i]?.ready) return i;
  }
  return null;
}

/**
 * Where a queue started at `songId` (or the first song) begins: that song when it is ready,
 * else the next ready one after it. Null when nothing from there on can play.
 */
export function startIndex(entries: readonly QueueEntry[], songId?: string): number | null {
  const at =
    songId === undefined
      ? 0
      : Math.max(
          0,
          entries.findIndex((e) => e.songId === songId),
        );
  if (entries[at]?.ready) return at;
  return nextReadyIndex(entries, at, 1);
}

/**
 * A song opened on its own page: a queue that holds it moves to it (and plays on from there);
 * otherwise the song becomes a queue of its own.
 */
export function focusSong(q: PlayQueue | null, entry: QueueEntry, source: QueueSource): PlayQueue {
  if (q && q.source.projectId === source.projectId) {
    const i = q.entries.findIndex((e) => e.songId === entry.songId);
    if (i >= 0) {
      const entries = [...q.entries];
      entries[i] = { ...entry, ready: true };
      return { ...q, entries, index: i };
    }
  }
  return { entries: [{ ...entry, ready: true }], index: 0, source: { ...source, kind: "song" } };
}

/**
 * Takes deleted songs out of the queue. `"stopped"`: the playing song is gone (the queue is null
 * then); `"removed"`: other entries went and the index follows the playing song; `"none"`.
 */
export function dropGone(
  q: PlayQueue | null,
  gone: GoneSongs,
): { result: "stopped" | "removed" | "none"; queue: PlayQueue | null } {
  if (!q) return { result: "none", queue: q };
  const ids = new Set(gone.songIds ?? []);
  const projectGone = gone.projectId !== undefined && gone.projectId === q.source.projectId;
  const hit = (e: QueueEntry) => projectGone || ids.has(e.songId);
  if (!q.entries.some(hit)) return { result: "none", queue: q };
  const cur = currentEntry(q);
  if (!cur || hit(cur)) return { result: "stopped", queue: null };
  const entries = q.entries.filter((e) => !hit(e));
  return { result: "removed", queue: { ...q, entries, index: entries.indexOf(cur) } };
}
