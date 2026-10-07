import type {
  Comment,
  CreateComment,
  CreateMarker,
  Marker,
  MixerState,
  OfflineEvent,
  UpdateMarker,
} from "@bandroom/shared";
import type { OfflineDb, OutboxEntry, OutboxKind } from "./db";

/** Outbox payloads by kind (SPEC §13): what was done offline, replayed in order when online. */
export interface OutboxPayloads {
  /** `preview`: what the list shows until the server has it. */
  "comment.create": { tempId: string; body: CreateComment; preview?: Comment };
  "marker.create": { tempId: string; body: CreateMarker; preview?: Marker };
  /** `base` is the marker as it was when edited (for the per-field merge). */
  "marker.update": { markerId: string; patch: UpdateMarker; base: Marker; editedAt: number };
  "marker.delete": { markerId: string };
  "mixer.put": { state: MixerState };
  "offline.event": { target: "song" | "project"; id: string; body: OfflineEvent };
}

export type TypedEntry<K extends OutboxKind = OutboxKind> = OutboxEntry & {
  kind: K;
  payload: OutboxPayloads[K];
};

export function payloadOf<K extends OutboxKind>(e: OutboxEntry, kind: K): OutboxPayloads[K] | null {
  return e.kind === kind ? (e.payload as OutboxPayloads[K]) : null;
}

const MARKER_FIELDS = ["name", "color", "note", "startSec", "endSec", "anchor"] as const;

/**
 * Last write wins per field (SPEC §13): an offline edit keeps the fields the user changed, except
 * where the server changed the same field after the edit (newer `updatedAt`). A marker deleted on
 * the server drops the edit (null).
 */
export function mergeMarkerEdit(
  base: Marker,
  server: Marker | undefined,
  patch: UpdateMarker,
  editedAt: number,
): UpdateMarker | null {
  if (!server) return null;
  const out: UpdateMarker = {};
  for (const k of MARKER_FIELDS) {
    if (!(k in patch) || patch[k] === undefined) continue;
    const serverChanged = server[k] !== base[k];
    if (serverChanged && server.updatedAt > editedAt) continue;
    (out as Record<string, unknown>)[k] = patch[k];
  }
  return out;
}

export interface OutboxSender {
  createComment(songId: string, body: CreateComment): Promise<{ id: string }>;
  createMarker(songId: string, body: CreateMarker): Promise<{ id: string }>;
  listMarkers(songId: string): Promise<Marker[]>;
  updateMarker(id: string, patch: UpdateMarker): Promise<void>;
  deleteMarker(id: string): Promise<void>;
  putMixer(songId: string, state: MixerState): Promise<void>;
  offlineEvent(target: "song" | "project", id: string, body: OfflineEvent): Promise<void>;
}

export interface ReplayResult {
  sent: number;
  /**
   * Changes the server no longer accepts (e.g. the marker was deleted meanwhile); `locked`: the
   * song was locked meanwhile (SPEC §25.12).
   */
  dropped: { kind: OutboxKind; songId: string | null; locked?: boolean }[];
  /** Stopped at a network failure; the rest waits for the next attempt. */
  stopped: boolean;
}

export interface ReplayDeps {
  db: OfflineDb;
  send: OutboxSender;
  isNetworkError(err: unknown): boolean;
  /** The server refused because the song is locked (`SONG_LOCKED`). */
  isSongLocked?(err: unknown): boolean;
  onSent?(entry: OutboxEntry): void;
}

/** Swaps a temporary id (item created offline) for the server's id in later entries. */
function rewriteIds(e: OutboxEntry, tempId: string, realId: string): OutboxEntry | null {
  const c = payloadOf(e, "comment.create");
  if (c?.body.parentId === tempId) {
    return { ...e, payload: { ...c, body: { ...c.body, parentId: realId } } };
  }
  const u = payloadOf(e, "marker.update");
  if (u?.markerId === tempId) return { ...e, payload: { ...u, markerId: realId } };
  const d = payloadOf(e, "marker.delete");
  if (d?.markerId === tempId) return { ...e, payload: { ...d, markerId: realId } };
  return null;
}

/** Whether an id was made up offline (not yet known to the server). */
export const isTempId = (id: string) => id.startsWith("offline-");
export const tempId = (requestId: string) => `offline-${requestId}`;

/**
 * Replays the outbox in order (SPEC §13). Every entry carries its client UUID, so a replay that
 * was interrupted after the server accepted it does not create duplicates.
 */
export async function replayOutbox(deps: ReplayDeps): Promise<ReplayResult> {
  const result: ReplayResult = { sent: 0, dropped: [], stopped: false };
  const markerLists = new Map<string, Marker[]>();
  const markersOf = async (songId: string) => {
    let list = markerLists.get(songId);
    if (!list) {
      list = await deps.send.listMarkers(songId);
      markerLists.set(songId, list);
    }
    return list;
  };

  let entries = await deps.db.outbox();
  while (entries.length > 0) {
    const [e, ...rest] = entries;
    if (!e || e.seq === undefined) break;
    let createdId: { temp: string; real: string } | null = null;
    try {
      const songId = e.songId ?? "";
      const comment = payloadOf(e, "comment.create");
      const markerNew = payloadOf(e, "marker.create");
      const markerEdit = payloadOf(e, "marker.update");
      const markerDel = payloadOf(e, "marker.delete");
      const mixer = payloadOf(e, "mixer.put");
      const event = payloadOf(e, "offline.event");
      let applied = true;
      if (comment) {
        if (comment.body.parentId && isTempId(comment.body.parentId)) applied = false;
        else {
          const { id } = await deps.send.createComment(songId, comment.body);
          createdId = { temp: comment.tempId, real: id };
        }
      } else if (markerNew) {
        const { id } = await deps.send.createMarker(songId, markerNew.body);
        createdId = { temp: markerNew.tempId, real: id };
        markerLists.delete(songId);
      } else if (markerEdit) {
        const server = isTempId(markerEdit.markerId)
          ? undefined
          : (await markersOf(songId)).find((m) => m.id === markerEdit.markerId);
        const patch = mergeMarkerEdit(
          markerEdit.base,
          server,
          markerEdit.patch,
          markerEdit.editedAt,
        );
        if (patch === null) applied = false;
        else if (Object.keys(patch).length > 0) {
          await deps.send.updateMarker(markerEdit.markerId, patch);
          markerLists.delete(songId);
        }
      } else if (markerDel) {
        if (!isTempId(markerDel.markerId)) await deps.send.deleteMarker(markerDel.markerId);
      } else if (mixer) {
        await deps.send.putMixer(songId, mixer.state);
      } else if (event) {
        await deps.send.offlineEvent(event.target, event.id, event.body);
      }
      if (applied) {
        result.sent += 1;
        deps.onSent?.(e);
      } else result.dropped.push({ kind: e.kind, songId: e.songId });
    } catch (err) {
      if (deps.isNetworkError(err)) {
        result.stopped = true;
        return result;
      }
      // The server rejected it (deleted meanwhile, no permission any more, song locked…): drop
      // it; the summary says why.
      result.dropped.push({
        kind: e.kind,
        songId: e.songId,
        ...(deps.isSongLocked?.(err) === true && { locked: true }),
      });
    }
    await deps.db.deleteOutbox(e.seq);
    if (createdId) {
      const { temp, real } = createdId;
      for (const r of rest) {
        const next = rewriteIds(r, temp, real);
        if (next) await deps.db.putOutbox(next);
      }
    }
    entries = await deps.db.outbox();
  }
  return result;
}

/** Keeps only the latest mixer state per song (it is a full replacement, SPEC §11.3). */
export async function enqueueMixer(
  db: OfflineDb,
  songId: string,
  state: MixerState,
  requestId: string,
  now: number,
): Promise<void> {
  for (const e of await db.outbox()) {
    if (e.kind === "mixer.put" && e.songId === songId && e.seq !== undefined) {
      await db.deleteOutbox(e.seq);
    }
  }
  await db.addOutbox({ requestId, kind: "mixer.put", songId, createdAt: now, payload: { state } });
}
