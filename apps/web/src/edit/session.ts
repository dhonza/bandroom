import {
  cancelEditSession,
  getEditSession,
  saveEditSession,
  startEditSession,
  takeOverEditSession,
  type EditSession,
  type Track,
  type TrackVersion,
} from "@bandroom/shared";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import { errorMessage } from "../api/errorMessage";
import { useOptionalUser } from "../auth/session";
import { onReconnect } from "../offline/online";
import { editSyncAction, endingOf, rememberApplying, resultOf } from "./editSync";
import { useFinishedEdit } from "./finished";
import {
  enterEdit,
  exitEdit,
  setEditPhase,
  type EditPhase,
  runOp,
  savedAt,
  setSaveStatus,
  useEdit,
  type LoadedSession,
} from "./store";

/**
 * Edit sessions on the server (SPEC §24.7, §24.11): start, reload, autosave 1 s after the last
 * change with optimistic concurrency on `rev`, takeover and cancel. The song page follows the
 * session through `edit.changed` (the session query) and `song.updated` (the song's `editing`).
 */

export const editKeys = {
  session: (songId: string) => ["songs", songId, "edit-session"] as const,
};

/** Autosave delay after the last change (SPEC §24.7). */
export const AUTOSAVE_MS = 1000;
const RETRY_MS = 5000;

export function useEditSessionQuery(songId: string, enabled = true) {
  return useQuery({
    queryKey: editKeys.session(songId),
    queryFn: ({ signal }) => api(getEditSession, { params: { id: songId } }, { signal }),
    enabled,
  });
}

/** The versions the base plays (the tracks' current versions; the lock keeps them). */
export function versionsFor(
  session: Pick<EditSession, "base">,
  tracks: readonly Track[],
): Record<string, TrackVersion> {
  const ids = new Set(session.base?.tracks.map((t) => t.versionId));
  const out: Record<string, TrackVersion> = {};
  for (const t of tracks) if (t.current && ids.has(t.current.id)) out[t.current.id] = t.current;
  return out;
}

/** The owner's view of a session as the edit store loads it; null without the editing state. */
export function loadedOf(session: EditSession, tracks: readonly Track[]): LoadedSession | null {
  const { base, ops, cursor, options, rev } = session;
  if (!base || !ops || cursor === undefined || !options || rev === undefined) return null;
  return {
    session: { id: session.id, songId: session.songId, rev },
    base,
    ops,
    cursor,
    options,
    versions: versionsFor(session, tracks),
  };
}

function load(session: EditSession, tracks: readonly Track[], phase?: EditPhase): boolean {
  const loaded = loadedOf(session, tracks);
  if (loaded) enterEdit(phase ? { ...loaded, phase } : loaded);
  return loaded !== null;
}

export async function startEdit(
  qc: QueryClient,
  songId: string,
  tracks: readonly Track[],
): Promise<void> {
  const { session } = await api(startEditSession, { params: { id: songId } });
  qc.setQueryData(editKeys.session(songId), { session });
  load(session, tracks);
}

export async function takeOverEdit(
  qc: QueryClient,
  sessionId: string,
  songId: string,
  tracks: readonly Track[],
): Promise<void> {
  const { session } = await api(takeOverEditSession, { params: { id: sessionId } });
  qc.setQueryData(editKeys.session(songId), { session });
  load(session, tracks);
}

/** Cancels a session (the own one, or another editor's); nothing else changes. */
export async function cancelEdit(
  qc: QueryClient,
  sessionId: string,
  songId: string,
): Promise<void> {
  const mine = useEdit.getState().session?.id === sessionId;
  // Nothing more is saved: the session ends as it is on the server.
  if (mine) useEdit.setState({ dirty: false });
  try {
    await api(cancelEditSession, { params: { id: sessionId } });
  } catch (err) {
    // Already ended elsewhere: leave edit mode all the same.
    if (!(err instanceof ApiError && err.code === "EDIT_SESSION_STATE")) throw err;
  }
  if (mine) exitEdit();
  qc.setQueryData(editKeys.session(songId), { session: null });
  void qc.invalidateQueries({ queryKey: ["songs", songId], exact: true });
}

function notify(message: string, color = "yellow") {
  notifications.show({ id: "edit-session", color, message, autoClose: 8000 });
}

/**
 * Keeps the page's edit mode in line with the server's session: the owner's page enters edit
 * mode with it (a reload continues the session), a session taken over or ended elsewhere leaves
 * edit mode with a note, and a newer saved state from another tab replaces an unchanged one.
 */
export function useEditSessionSync(
  songId: string,
  tracks: readonly Track[] | undefined,
): EditSession | null {
  const { t } = useTranslation();
  const me = useOptionalUser()?.id ?? null;
  const query = useEditSessionQuery(songId, me !== null);
  const server = query.data?.session ?? null;
  const loaded = query.data !== undefined;
  const finish = useFinishedEdit(songId);
  useEffect(() => {
    if (!loaded || !tracks) return;
    const local = useEdit.getState();
    const mineLocal = local.songId === songId && local.session !== null ? local.session : null;
    const action = editSyncAction(
      server,
      me,
      mineLocal && {
        id: mineLocal.id,
        rev: mineLocal.rev,
        busy: local.dirty || local.save === "saving",
        phase: local.phase,
      },
      mineLocal ? endingOf(mineLocal.id) : null,
    );
    if (server?.status === "applying") rememberApplying(server);
    switch (action.kind) {
      case "none":
        return;
      case "load":
        if (server) load(server, tracks, action.phase);
        return;
      case "applying":
        setEditPhase("applying");
        return;
      case "failed":
        if (server) load(server, tracks, "editing");
        notify(t("edit.progress.failedNote"), "red");
        return;
      case "committedKeep":
        if (server) load(server, tracks, "editing");
        finish(mineLocal ? resultOf(mineLocal.id) : null);
        return;
      case "finished":
        exitEdit();
        finish(mineLocal ? resultOf(mineLocal.id) : null);
        return;
      case "cancelled":
        exitEdit();
        notify(t("edit.progress.cancelledNote"));
        return;
      case "takenOver":
        exitEdit();
        notify(t("edit.takenOver", { name: action.name }));
        return;
      case "ended":
        exitEdit();
        notify(t("edit.ended"));
        return;
    }
  }, [loaded, server, tracks, songId, me, t, finish]);
  useAutosave(songId, tracks, t);
  return server;
}

/** Sends the pending changes now (the autosave of the page registers it). */
let flusher: (() => void) | null = null;

/**
 * Saves what is not saved yet and waits for it (Apply and Bounce build on the saved state,
 * SPEC §24.8). False when the session is gone or the save does not get through in time.
 */
export async function flushEditSave(timeoutMs = 15_000): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const s = useEdit.getState();
    if (!s.session) return false;
    if (!s.dirty && s.save !== "saving") return true;
    if (Date.now() - started > timeoutMs) return false;
    if (s.save !== "saving") flusher?.();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const samePrefix = <T>(list: readonly T[], prefix: readonly T[]) =>
  list.length >= prefix.length && prefix.every((x, i) => list[i] === x);

/** Saves the session 1 s after the last change (SPEC §24.7); retries while the network is gone. */
function useAutosave(songId: string, tracks: readonly Track[] | undefined, t: TFunction) {
  const qc = useQueryClient();
  const known = tracks ?? null;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let again = false;
    const schedule = (ms = AUTOSAVE_MS) => {
      clearTimeout(timer);
      timer = setTimeout(() => void save(), ms);
    };
    const onConflict = async () => {
      const { session } = await api(getEditSession, { params: { id: songId } }).catch(() => ({
        session: null,
      }));
      qc.setQueryData(editKeys.session(songId), { session });
      if (session && known && load(session, known)) notify(t("edit.conflict"));
      else exitEdit();
    };
    const save = async (): Promise<void> => {
      const s = useEdit.getState();
      if (!s.session || !s.dirty || s.songId !== songId) return;
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      const seq = s.changeSeq;
      const sentOps = s.ops;
      setSaveStatus("saving");
      try {
        const { session } = await api(saveEditSession, {
          params: { id: s.session.id },
          body: { rev: s.session.rev, ops: s.ops, cursor: s.cursor, options: s.options },
        });
        qc.setQueryData(editKeys.session(songId), { session });
        const cur = useEdit.getState();
        if (cur.session?.id !== session.id) return;
        const folded = (session.base?.foldedOps ?? 0) !== (cur.base?.foldedOps ?? 0);
        if (folded && known) {
          // The oldest ops went into the base: continue from the server's state, then redo the
          // ops made since this save was sent.
          const extra = samePrefix(cur.ops, sentOps)
            ? cur.ops.slice(sentOps.length, Math.max(sentOps.length, cur.cursor))
            : [];
          load(session, known);
          for (const op of extra) runOp(op);
          if (extra.length === 0) savedAt(session.rev ?? 0, useEdit.getState().changeSeq);
        } else savedAt(session.rev ?? 0, seq);
      } catch (err) {
        const code = err instanceof ApiError ? err.code : null;
        if (code === "EDIT_CONFLICT") await onConflict();
        else if (code === "NOT_SESSION_OWNER" || code === "EDIT_SESSION_STATE") {
          exitEdit();
          notify(errorMessage(t, err));
          void qc.invalidateQueries({ queryKey: editKeys.session(songId) });
        } else if (code === "VALIDATION_FAILED") {
          setSaveStatus("error");
          notify(errorMessage(t, err), "red");
        } else {
          // Offline or the server is away: kept in memory, saved on reconnect (SPEC §24.7).
          setSaveStatus("error");
          schedule(RETRY_MS);
        }
      } finally {
        inFlight = false;
        if (again) {
          again = false;
          schedule();
        }
      }
    };
    const flush = () => {
      clearTimeout(timer);
      void save();
    };
    flusher = flush;
    const unsub = useEdit.subscribe((s, p) => {
      if (s.changeSeq !== p.changeSeq && s.songId === songId) schedule();
    });
    const stopReconnect = onReconnect(() => {
      if (useEdit.getState().dirty) schedule(0);
    });
    return () => {
      if (flusher === flush) flusher = null;
      unsub();
      stopReconnect();
      clearTimeout(timer);
      // Leaving the page: what is not saved yet goes now.
      void save();
    };
  }, [songId, qc, t, known]);
}
