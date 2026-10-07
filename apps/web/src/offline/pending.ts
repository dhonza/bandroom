import type { Comment, Marker, MixerState } from "@bandroom/shared";
import type { OutboxEntry } from "./db";
import { isTempId, payloadOf } from "./outbox";

/**
 * Offline changes shown before the server has them (SPEC §13): the song page merges the outbox
 * into what it read (from the network or the offline cache).
 */
export function withPendingComments(
  list: Comment[],
  outbox: readonly OutboxEntry[],
  songId: string,
): Comment[] {
  let out = list;
  for (const e of outbox) {
    const p = payloadOf(e, "comment.create");
    if (!p?.preview || e.songId !== songId) continue;
    const c = p.preview;
    if (c.parentId === null) {
      if (!out.some((x) => x.id === c.id)) out = [...out, c];
    } else {
      out = out.map((x) =>
        x.id === c.parentId && !x.replies.some((r) => r.id === c.id)
          ? { ...x, replies: [...x.replies, c] }
          : x,
      );
    }
  }
  return out;
}

export function withPendingMarkers(
  list: Marker[],
  outbox: readonly OutboxEntry[],
  songId: string,
): Marker[] {
  let out = list;
  for (const e of outbox) {
    if (e.songId !== songId) continue;
    const created = payloadOf(e, "marker.create");
    if (created?.preview && !out.some((m) => m.id === created.preview?.id)) {
      out = [...out, created.preview];
    }
    const edit = payloadOf(e, "marker.update");
    if (edit) {
      out = out.map((m) =>
        m.id === edit.markerId
          ? {
              ...m,
              ...edit.patch,
              endSec: m.type === "section" ? (edit.patch.endSec ?? m.endSec) : null,
            }
          : m,
      );
    }
    const del = payloadOf(e, "marker.delete");
    if (del) out = out.filter((m) => m.id !== del.markerId);
  }
  return out;
}

/** The latest mixer state saved offline for a song, if any. */
export function pendingMixer(outbox: readonly OutboxEntry[], songId: string): MixerState | null {
  let state: MixerState | null = null;
  for (const e of outbox) {
    const p = payloadOf(e, "mixer.put");
    if (p && e.songId === songId) state = p.state;
  }
  return state;
}

/** Items created offline and not sent yet ("Waiting to sync"). */
export const isPending = (id: string) => isTempId(id);
