/**
 * The engine's play queue (SPEC §6.10): pure logic, kept free of the engine and React so it can
 * be tested in Node. The controller holds one queue in its store.
 */

/** A song as `getProjectQueue` lists it (no project: the request names it). */
export interface QueueItem {
  songId: string;
  title: string;
  subtitle: string;
  /** Has audio ready to play (`getProjectQueue`'s `ready`). */
  ready: boolean;
}

/** The project a queued song belongs to (a queue can mix projects; the art is its cover). */
export interface QueueProject {
  projectId: string;
  projectName: string;
  imageHash: string | null;
}

export type QueueEntry = QueueItem & QueueProject;

/**
 * Where the queue comes from: a project ("Play all", a song row), one song page, or several
 * projects once songs of another project were added ("mixed"; the project fields then keep the
 * project it started from).
 */
export interface QueueSource extends QueueProject {
  kind: "project" | "song" | "mixed";
}

export interface PlayQueue {
  entries: QueueEntry[];
  index: number;
  source: QueueSource;
}

/** Repeat: off (stop at the end), the whole queue, or the current song. */
export type RepeatMode = "off" | "all" | "one";

export const REPEAT_MODES: readonly RepeatMode[] = ["off", "all", "one"];

/** The repeat toggle's next mode: off → all → one → off. */
export function nextRepeat(mode: RepeatMode): RepeatMode {
  return mode === "off" ? "all" : mode === "all" ? "one" : "off";
}

/** Songs that were deleted: by id, or every song of a deleted project. */
export interface GoneSongs {
  songIds?: readonly string[];
  projectId?: string;
}

/** Queue entries of one project's songs. */
export function entriesOf(items: readonly QueueItem[], project: QueueProject): QueueEntry[] {
  return items.map((i) => ({
    songId: i.songId,
    title: i.title,
    subtitle: i.subtitle,
    ready: i.ready,
    projectId: project.projectId,
    projectName: project.projectName,
    imageHash: project.imageHash,
  }));
}

export function currentEntry(q: PlayQueue | null): QueueEntry | null {
  return q?.entries[q.index] ?? null;
}

/** The next ready entry from `from` in a direction (not counting `from`); null at the end. */
export function nextReadyIndex(
  entries: readonly QueueItem[],
  from: number,
  dir: 1 | -1,
): number | null {
  for (let i = from + dir; i >= 0 && i < entries.length; i += dir) {
    if (entries[i]?.ready) return i;
  }
  return null;
}

/**
 * The next (or previous) song for the next/previous buttons: with repeat on (all or one) the
 * queue wraps around, possibly back to the current song; null when nothing can play.
 */
export function stepIndex(q: PlayQueue, dir: 1 | -1, repeat: RepeatMode): number | null {
  const i = nextReadyIndex(q.entries, q.index, dir);
  if (i !== null || repeat === "off") return i;
  return nextReadyIndex(q.entries, dir === 1 ? -1 : q.entries.length, dir);
}

/**
 * What plays when a song ends: repeat one restarts it, repeat all wraps at the end, off stops
 * there (null).
 */
export function endedIndex(q: PlayQueue, repeat: RepeatMode): number | null {
  if (repeat === "one" && q.entries[q.index]) return q.index;
  return stepIndex(q, 1, repeat);
}

/**
 * Where a queue started at `songId` (or the first song) begins: that song when it is ready,
 * else the next ready one after it. Null when nothing from there on can play.
 */
export function startIndex(entries: readonly QueueItem[], songId?: string): number | null {
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
  if (q) {
    const i = q.entries.findIndex((e) => e.songId === entry.songId);
    if (i >= 0) {
      const entries = [...q.entries];
      entries[i] = { ...entry, ready: true };
      return { ...q, entries, index: i };
    }
  }
  return { entries: [{ ...entry, ready: true }], index: 0, source: { ...source, kind: "song" } };
}

/** Songs after `index` the queue knew as not ready yet (they may have finished processing). */
export function waitingAfter(q: PlayQueue): boolean {
  return q.entries.slice(q.index + 1).some((e) => !e.ready);
}

/**
 * The queue's entries with the ready flags of a fresh `getProjectQueue` answer for `projectId`;
 * a song of that project no longer in it (deleted, hidden) cannot play. Other projects' songs
 * stay as they are.
 */
export function withFreshReady(
  entries: readonly QueueEntry[],
  projectId: string,
  fresh: readonly QueueItem[],
): QueueEntry[] {
  const ready = new Map(fresh.map((e) => [e.songId, e.ready]));
  return entries.map((e) =>
    e.projectId === projectId ? { ...e, ready: ready.get(e.songId) ?? false } : e,
  );
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
  const hit = (e: QueueEntry) =>
    (gone.projectId !== undefined && e.projectId === gone.projectId) || ids.has(e.songId);
  if (!q.entries.some(hit)) return { result: "none", queue: q };
  const cur = currentEntry(q);
  if (!cur || hit(cur)) return { result: "stopped", queue: null };
  const entries = q.entries.filter((e) => !hit(e));
  return { result: "removed", queue: { ...q, entries, index: entries.indexOf(cur) } };
}

// ——— editing the queue (the queue pane, song menus) ——————————————————————————————————

/** The source after the entries changed: songs of another project make the queue mixed. */
function sourceFor(source: QueueSource, entries: readonly QueueEntry[]): QueueSource {
  if (source.kind === "mixed") return source;
  return entries.some((e) => e.projectId !== source.projectId)
    ? { ...source, kind: "mixed" }
    : source;
}

/** Entries in a new order, with the index following the current song. */
function reordered(q: PlayQueue, entries: QueueEntry[]): PlayQueue {
  const cur = currentEntry(q);
  const index = cur ? entries.indexOf(cur) : 0;
  return { entries, index: Math.max(0, index), source: sourceFor(q.source, entries) };
}

/** Moves the entry at `from` to `to` (both indexes in the current order). */
export function moveEntry(q: PlayQueue, from: number, to: number): PlayQueue {
  const moved = q.entries[from];
  if (!moved || to < 0 || to >= q.entries.length || from === to) return q;
  const entries = [...q.entries];
  entries.splice(from, 1);
  entries.splice(to, 0, moved);
  return reordered(q, entries);
}

/** Takes the entry at `i` out of the queue; the playing song stays (the queue keeps a song). */
export function removeEntry(q: PlayQueue, i: number): PlayQueue {
  if (i === q.index || !q.entries[i]) return q;
  return reordered(
    q,
    q.entries.filter((_, k) => k !== i),
  );
}

/**
 * Adds songs right after the current one ("Play next"). A song already queued moves there; the
 * playing song stays where it is.
 */
export function insertNext(q: PlayQueue, add: readonly QueueEntry[]): PlayQueue {
  const cur = currentEntry(q);
  const ids = new Set(add.map((e) => e.songId));
  const incoming = add.filter((e) => e.songId !== cur?.songId);
  const rest = q.entries.filter((e) => e === cur || !ids.has(e.songId));
  const at = cur ? rest.indexOf(cur) + 1 : 0;
  return reordered(q, [...rest.slice(0, at), ...incoming, ...rest.slice(at)]);
}

/** Adds songs at the end ("Add to queue"). A song already queued moves there. */
export function append(q: PlayQueue, add: readonly QueueEntry[]): PlayQueue {
  const cur = currentEntry(q);
  const ids = new Set(add.map((e) => e.songId));
  const incoming = add.filter((e) => e.songId !== cur?.songId);
  const rest = q.entries.filter((e) => e === cur || !ids.has(e.songId));
  return reordered(q, [...rest, ...incoming]);
}

/** Clears the queue but the playing song, which becomes a queue of its own. */
export function clearQueue(q: PlayQueue): PlayQueue {
  const cur = currentEntry(q);
  if (!cur) return q;
  return {
    entries: [cur],
    index: 0,
    source: {
      kind: "song",
      projectId: cur.projectId,
      projectName: cur.projectName,
      imageHash: cur.imageHash,
    },
  };
}

/** A new queue of `entries` (nothing was queued): its source is the first song's project. */
export function queueOf(entries: readonly QueueEntry[]): PlayQueue | null {
  const first = entries[0];
  if (!first) return null;
  const source: QueueSource = {
    kind: "project",
    projectId: first.projectId,
    projectName: first.projectName,
    imageHash: first.imageHash,
  };
  return { entries: [...entries], index: 0, source: sourceFor(source, entries) };
}

// ——— a saved queue checked against the server (persistence) ————————————————————————————

/**
 * A saved queue with the projects' fresh song lists: songs no longer there are dropped, the
 * others take their fresh title and ready flag. `"gone"`: the project cannot be read any more;
 * a missing project (not answered, e.g. offline) keeps its songs as saved. The index follows the
 * current song, else the next song left (else the last one); null when nothing is left.
 */
export function reconcile(
  q: PlayQueue,
  fresh: ReadonlyMap<string, readonly QueueItem[] | "gone">,
): PlayQueue | null {
  const kept: { entry: QueueEntry; from: number }[] = [];
  q.entries.forEach((e, from) => {
    const list = fresh.get(e.projectId);
    if (list === undefined) {
      kept.push({ entry: e, from });
      return;
    }
    if (list === "gone") return;
    const item = list.find((x) => x.songId === e.songId);
    if (item) {
      kept.push({
        entry: { ...e, title: item.title, subtitle: item.subtitle, ready: item.ready },
        from,
      });
    }
  });
  if (kept.length === 0) return null;
  const after = kept.findIndex((k) => k.from >= q.index);
  const index = after >= 0 ? after : kept.length - 1;
  const entries = kept.map((k) => k.entry);
  return { entries, index, source: q.source };
}
