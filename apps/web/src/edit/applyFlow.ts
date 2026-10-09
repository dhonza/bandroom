import {
  applyEditSession,
  bounceEditSession,
  retryEditSession,
  reviewEditSession,
  uuidv7,
  type BounceEditSession,
  type EditOutcomeKind,
  type EditReview,
  type EditReviewQuery,
  type EditSession,
} from "@bandroom/shared";
import { notifications } from "@mantine/notifications";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { useSongTracks } from "../features/library/queries";
import { rememberApplying } from "./editSync";
import type { ReviewView } from "./review";
import { editKeys, flushEditSave, useEditSessionQuery } from "./session";
import { openEditDialog, setEditPhase, useEdit } from "./store";

/**
 * Apply and Bounce on the client (SPEC §24.8, §24.9, §24.14): the review (after the pending
 * changes are saved), starting the render, its progress from the session (SSE `edit.changed`
 * refetches it), "Retry failed" and the result of a finished one.
 */

export type BounceKind = Exclude<EditOutcomeKind, "apply">;

/** Titles of the songs a bounce makes (by range id), for the progress list. */
const rangeTitles = new Map<string, string>();

// ——— Review ——————————————————————————————————————————————————————————————————————————————

/** The server's review as the dialogs show it. */
export function reviewView(review: EditReview): ReviewView {
  const names = new Map(review.outputs.map((o) => [o.trackId, o.trackName]));
  const tracks: ReviewView["tracks"] = [];
  if (review.kind === "bounceSongs") {
    // One row per new song: its title and length.
    const songs = new Map<string, { name: string; sec: number }>();
    for (const o of review.outputs) {
      const key = o.rangeId ?? o.key;
      const prev = songs.get(key);
      songs.set(key, {
        name: o.songTitle ?? o.title,
        sec: Math.max(prev?.sec ?? 0, o.durationSec),
      });
    }
    for (const [key, s] of songs) tracks.push({ key, name: s.name, oldSec: null, newSec: s.sec });
  } else {
    for (const o of review.outputs)
      tracks.push({ key: o.key, name: o.title, oldSec: o.oldDurationSec, newSec: o.durationSec });
  }
  return {
    tracks,
    bytes: review.totalBytes,
    quotaLeft: review.quotaRemainingBytes,
    diskFree: review.diskFreeBytes,
    fitsQuota: review.fitsQuota,
    fitsDisk: review.fitsDisk,
    estimateSec: review.estimatedSec,
    warnings: review.warnings.map((w) => ({
      code: w.code,
      tracks: [...new Set(w.trackIds.map((id) => names.get(id) ?? ""))].filter((n) => n !== ""),
    })),
    timeline: review.remap
      ? {
          markersMoved: review.remap.markersMoved,
          markersDeleted: review.remap.markersDeleted,
          sectionsMoved: review.remap.sectionsMoved,
          sectionsDeleted: review.remap.sectionsDeleted,
          commentsMoved: review.remap.commentsMoved,
          commentsEditedOut: review.remap.commentsEditedOut,
          tempoChanged: review.remap.tempoChanged,
        }
      : null,
  };
}

export type ReviewOptions = Omit<EditReviewQuery, "kind">;

/**
 * The review of `kind` while its dialog is open: the pending changes are saved first, so the
 * review (and the Apply/Bounce that names its rev) builds on what the server has.
 */
export function useEditReview(kind: EditOutcomeKind, opened: boolean, options?: ReviewOptions) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const sessionId = useEdit((s) => s.session?.id ?? null);
  // Each opening saves first; the result belongs to that opening only.
  const opening = useMemo(() => (opened ? {} : null), [opened]);
  const [flushed, setFlushed] = useState<{ opening: object; ok: boolean } | null>(null);
  useEffect(() => {
    if (!opening) return;
    let live = true;
    void flushEditSave().then((ok) => {
      if (live) setFlushed({ opening, ok });
    });
    return () => {
      live = false;
    };
  }, [opening]);
  const saved = !opening || flushed?.opening !== opening ? "pending" : flushed.ok ? "ok" : "failed";
  const rev = useEdit((s) => s.session?.rev ?? 0);
  const query = useQuery({
    queryKey: ["edit-review", sessionId, rev, kind, options ?? null],
    queryFn: ({ signal }) =>
      api(
        reviewEditSession,
        { params: { id: sessionId ?? "" }, query: { kind, ...options } },
        { signal },
      ),
    enabled: opened && saved === "ok" && sessionId !== null,
    placeholderData: keepPreviousData,
    staleTime: 0,
    gcTime: 30_000,
    retry: false,
  });
  const review = query.data?.review ?? null;
  // A review of another kind (kept while the next one loads) is not shown.
  const current = review && review.kind === kind ? review : null;
  const view = useMemo(() => (current ? reviewView(current) : null), [current]);
  const error =
    saved === "failed" ? t("edit.review.notSaved") : query.error ? apiError(query.error) : null;
  return {
    view,
    review: current,
    ranges: current?.ranges ?? null,
    rev: current?.rev ?? rev,
    blocked: current ? !current.fitsDisk || !current.fitsQuota : true,
    loading: query.isFetching,
    error,
  };
}

// ——— Starting, retrying, cancelling ——————————————————————————————————————————————————————

export type BounceBody = Omit<BounceEditSession, "requestId" | "rev">;

/** Apply, Bounce, Retry failed; the session turns `applying` and the edit read-only. */
export function useApplyActions() {
  const { t } = useTranslation();
  const apiError = useApiError();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"apply" | "bounce" | "retry" | null>(null);
  const started = (session: EditSession) => {
    qc.setQueryData(editKeys.session(session.songId), { session });
    rememberApplying(session);
    openEditDialog(null);
    if (session.status === "applying") setEditPhase("applying");
  };
  const fail = (err: unknown) => {
    notifications.show({ color: "red", message: apiError(err) });
    const songId = useEdit.getState().songId;
    if (err instanceof ApiError && err.code === "EDIT_CONFLICT" && songId)
      void qc.invalidateQueries({ queryKey: editKeys.session(songId) });
  };
  const run = async (
    what: "apply" | "bounce" | "retry",
    call: (id: string) => Promise<EditSession>,
  ) => {
    const id = useEdit.getState().session?.id;
    if (!id) return;
    setBusy(what);
    try {
      started(await call(id));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };
  return {
    busy,
    apply: (rev: number) =>
      run("apply", async (id) => {
        const { session } = await api(applyEditSession, {
          params: { id },
          body: { requestId: uuidv7(), rev },
        });
        return session;
      }),
    bounce: (rev: number, body: BounceBody) => {
      for (const r of body.ranges ?? []) rangeTitles.set(r.id, r.title);
      return run("bounce", async (id) => {
        const { session } = await api(bounceEditSession, {
          params: { id },
          body: { ...body, requestId: uuidv7(), rev },
        });
        return session;
      });
    },
    retry: () =>
      run("retry", async (id) => {
        const { session } = await api(retryEditSession, { params: { id } });
        notifications.show({
          id: "edit-session",
          color: "blue",
          message: t("edit.progress.retried"),
        });
        return session;
      }),
  };
}

// ——— Progress ————————————————————————————————————————————————————————————————————————————

export interface OutputProgress {
  key: string;
  name: string;
  status: "queued" | "running" | "done" | "failed" | "skipped";
  progress: number;
  error: string | null;
}

export interface RenderProgressView {
  kind: EditOutcomeKind;
  outputs: OutputProgress[];
  /** Still rendering (else: failed, the session is open again). */
  running: boolean;
  error: string | null;
}

/** The running (or failed) Apply/Bounce of the song in edit mode, from the server's session. */
export function useRenderProgress(): RenderProgressView | null {
  const { t } = useTranslation();
  const songId = useEdit((s) => s.songId) ?? "";
  const session = useEditSessionQuery(songId, songId !== "").data?.session ?? null;
  const tracks = useSongTracks(songId).data?.tracks;
  return useMemo(() => {
    if (!session?.outcome || !session.renders?.length) return null;
    const running = session.status === "applying";
    const failed = session.status === "open" && !!session.error;
    if (!running && !failed) return null;
    const names = new Map((tracks ?? []).map((tr) => [tr.id, tr.name]));
    const songNo = new Map<string, number>();
    for (const r of session.renders)
      if (r.rangeId && !songNo.has(r.rangeId)) songNo.set(r.rangeId, songNo.size + 1);
    const outputs = session.renders
      .filter((r) => r.status !== "skipped")
      .map((r): OutputProgress => {
        const track = names.get(r.trackId) ?? "";
        const song = r.rangeId
          ? (rangeTitles.get(r.rangeId) ?? t("edit.progress.song", { n: songNo.get(r.rangeId) }))
          : null;
        return {
          key: r.id,
          name: song ? `${song} · ${track}` : track,
          status: r.status,
          progress: r.progress,
          error: r.error,
        };
      });
    return { kind: session.outcome.kind, outputs, running, error: session.error ?? null };
  }, [session, tracks, t]);
}
