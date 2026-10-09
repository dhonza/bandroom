import {
  NotificationTypeSchema,
  StreamEventSchema,
  type NotificationType,
  type Track,
} from "@bandroom/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { projectKeys, songKeys } from "../features/library/queries";
import { apiUrl } from "../lib/media";
import { docKeys } from "../documents/queries";
import { onReconnect } from "../offline/online";
import { processingKey } from "../processing/queries";
import type { GoneSongs } from "../player/queue";
import { trashKeys } from "../trash/queries";

/** Events that change what a Trash list shows (SPEC §26.3). */
const TRASH_EVENTS: ReadonlySet<string> = new Set([
  "song.deleted",
  "song.restored",
  "track.deleted",
  "track.restored",
  "version.deleted",
  "version.restored",
  "trash.changed",
]);

/** Reconnect delays after the browser gives up on the stream (e.g. a 502 during a deploy). */
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * One SSE connection per tab (SPEC §18.5). The browser reconnects with Last-Event-ID; events
 * patch or invalidate TanStack Query caches. A browser stops reconnecting when the server answers
 * with anything but a 200 event stream (readyState CLOSED), so then the stream is recreated with
 * backoff (or right away when the app comes back online). After reopening following an error all
 * queries are refetched, since events may have been missed.
 */
export function useEventStream(
  enabled: boolean,
  notify: (type: NotificationType) => void = () => undefined,
  /** Songs deleted (also by others): the Listen queue drops them (SPEC §6.10). */
  gone: (songs: GoneSongs) => void = () => undefined,
): void {
  const qc = useQueryClient();
  const onNotification = useRef(notify);
  const onGone = useRef(gone);
  useEffect(() => {
    onNotification.current = notify;
    onGone.current = gone;
  }, [notify, gone]);
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = RECONNECT_MIN_MS;
    let hadError = false;

    const onEvent = (msg: MessageEvent<string>) => {
      let data: unknown;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      const parsed = StreamEventSchema.safeParse(data);
      if (!parsed.success) return;
      const e = parsed.data;
      if (e.type === "import.progress") {
        void qc.invalidateQueries({ queryKey: ["admin", "imports"] });
        void qc.invalidateQueries({ queryKey: processingKey });
        return;
      }
      if (TRASH_EVENTS.has(e.type)) void qc.invalidateQueries({ queryKey: trashKeys.all });
      if (e.type === "trash.changed") {
        // A purge frees space: the project's size changes (SPEC §28.6).
        if (e.projectId) void qc.invalidateQueries({ queryKey: projectKeys.all });
        return;
      }
      if (e.type === "song.deleted" && typeof e.data.songId === "string")
        onGone.current({ songIds: [e.data.songId] });
      if (e.type === "project.deleted") {
        const projectId = e.projectId ?? null;
        if (projectId) onGone.current({ projectId });
        void qc.invalidateQueries({ queryKey: projectKeys.all });
        return;
      }
      // Song deletes and moves are project-scoped (the song is no longer visible there); an open
      // song page refetches (SPEC §26.2).
      if (
        (e.type === "song.deleted" || e.type === "song.restored" || e.type === "song.moved") &&
        typeof e.data.songId === "string"
      )
        void qc.invalidateQueries({ queryKey: songKeys.detail(e.data.songId), exact: true });
      const songId = e.songId ?? null;
      if (e.type === "marker.changed") {
        if (songId) void qc.invalidateQueries({ queryKey: ["songs", songId, "markers"] });
        return;
      }
      if (e.type === "comment.changed") {
        if (songId) void qc.invalidateQueries({ queryKey: ["songs", songId, "comments"] });
        return;
      }
      if (e.type === "notification") {
        void qc.invalidateQueries({ queryKey: ["notifications"] });
        const kind = NotificationTypeSchema.safeParse(e.data.kind);
        if (kind.success) onNotification.current(kind.data);
        return;
      }
      if (e.type === "document.changed") {
        void qc.invalidateQueries({ queryKey: docKeys.all });
        return;
      }
      // Edit sessions (SPEC §24.7): the session's owner, status and rev; the edit lock itself
      // arrives as `song.updated`.
      if (e.type === "edit.changed") {
        if (songId) void qc.invalidateQueries({ queryKey: ["songs", songId, "edit-session"] });
        return;
      }
      if (e.type === "tempo.changed") {
        if (songId) void qc.invalidateQueries({ queryKey: ["songs", songId, "tempo"] });
        return;
      }
      if (e.type === "job.progress" && songId) {
        const versionId = typeof e.data.trackVersionId === "string" ? e.data.trackVersionId : null;
        const progress = typeof e.data.progress === "number" ? e.data.progress : null;
        qc.setQueryData<{ tracks: Track[] }>(songKeys.tracks(songId), (old) =>
          old && versionId
            ? {
                tracks: old.tracks.map((t) =>
                  t.current?.id === versionId
                    ? { ...t, current: { ...t.current, status: "processing", progress } }
                    : t,
                ),
              }
            : old,
        );
        return;
      }
      // Document ingest finishing (thumbnails, detected kind) also arrives as asset.ready/failed.
      if (e.type === "asset.ready" || e.type === "asset.failed") {
        void qc.invalidateQueries({ queryKey: docKeys.all });
        // Unscoped (admins only): the branding logo was processed (SPEC §25.1).
        if (!songId && !e.projectId) {
          void qc.invalidateQueries({ queryKey: ["admin", "settings"] });
          void qc.invalidateQueries({ queryKey: ["meta"] });
        }
      }
      // Media work started, finished or failed (SPEC §25.3).
      void qc.invalidateQueries({ queryKey: processingKey });
      // Tracks and versions changed: the song, its tracks and version stacks. Its
      // comments, markers, tempo, grants and mixer settings are left alone.
      if (songId) {
        void qc.invalidateQueries({ queryKey: songKeys.detail(songId), exact: true });
        void qc.invalidateQueries({ queryKey: songKeys.tracks(songId) });
        void qc.invalidateQueries({ queryKey: songKeys.allVersions(songId) });
      }
      // Project lists, details and song lists (counts, sizes), once per event.
      if (songId || e.projectId) void qc.invalidateQueries({ queryKey: projectKeys.all });
    };
    const connect = () => {
      clearTimeout(timer);
      timer = undefined;
      const source = new EventSource(apiUrl("/stream"));
      es = source;
      source.onopen = () => {
        delay = RECONNECT_MIN_MS;
        if (hadError) {
          hadError = false;
          void qc.invalidateQueries();
        }
      };
      source.onerror = () => {
        hadError = true;
        // CONNECTING: the browser retries by itself. CLOSED: it gave up, so retry ourselves.
        if (source.readyState !== EventSource.CLOSED) return;
        source.close();
        es = null;
        clearTimeout(timer);
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      };
      for (const type of EVENT_TYPES) source.addEventListener(type, onEvent);
    };
    const stopReconnect = onReconnect(() => {
      if (es !== null) return;
      connect();
    });
    connect();
    return () => {
      stopReconnect();
      clearTimeout(timer);
      es?.close();
      es = null;
    };
  }, [enabled, qc]);
}

const EVENT_TYPES = [
  "job.progress",
  "asset.ready",
  "asset.failed",
  "version.created",
  "song.created",
  // Trash (SPEC §26.3): deletes and restores of songs, tracks and versions, and purges.
  "song.deleted",
  "song.restored",
  "track.restored",
  "version.restored",
  "trash.changed",
  // Make multitrack song, copy and move (SPEC §26.5, §26.6): both projects' lists update, a
  // moved song's page shows its new project, a source song loses its moved tracks.
  "song.moved",
  "track.moved",
  // Lock state and song details (SPEC §25.12), default mix, colours, version gain (§25.6).
  "song.updated",
  "track.updated",
  "track.deleted",
  "version.updated",
  "version.deleted",
  "version.set_current",
  // Full quality removed (SPEC §26.4): badges and download menus change.
  "version.lossless_removed",
  "project.updated",
  /** A project went to the Trash: the Listen queue drops its songs, lists update. */
  "project.deleted",
  "marker.changed",
  "tempo.changed",
  "edit.changed",
  "comment.changed",
  "document.changed",
  "notification",
  "import.progress",
] as const;
