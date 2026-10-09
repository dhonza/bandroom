import type { UploadResult, UploadTarget } from "@bandroom/shared";
import { create } from "zustand";
import { memoryOfflineDb, type OfflineDb, type PendingTake } from "../offline/db";
import { takeMimeType, type TakeMeta, type WriterEvent } from "./takeTypes";

/**
 * The user's recorded takes on this device (SPEC §9): takes waiting for the stop dialog (just
 * recorded, or recovered after a crash) and saved takes waiting for their upload (IndexedDB
 * `takes`; the audio stays in OPFS until the upload succeeds). Offline, saved takes wait and
 * upload on reconnect and on the next app start.
 */

export interface TakesState {
  userId: string | null;
  /** Takes for the stop dialog, oldest first (the dialog shows the first). */
  review: TakeMeta[];
  pending: PendingTake[];
  /** The take being written. */
  recordingTakeId: string | null;
  /** The take writer failed (storage full, no OPFS); shown by the record sheet. */
  writerError: string | null;
  /** The last take uploaded (the project-page recorder opens its new song). */
  lastUploaded: { takeId: string; songId: string | null; trackId: string | null } | null;
}

const initial = (): TakesState => ({
  userId: null,
  review: [],
  pending: [],
  recordingTakeId: null,
  writerError: null,
  lastUploaded: null,
});

export const useTakes = create<TakesState>(initial);

/** What the takes service needs from the app (replaced in tests). */
export interface TakesDeps {
  /** The user's offline database; null: no offline session (kept in memory only). */
  db: () => OfflineDb | null;
  file: (userId: string, takeId: string) => Promise<File | null>;
  remove: (userId: string, takeId: string) => Promise<void>;
  upload: (
    file: File,
    target: UploadTarget,
    scope: { songId: string | null; projectId: string },
  ) => Promise<UploadResult>;
  setLabel: (versionId: string, label: string) => Promise<void>;
  isOnline: () => boolean;
  /** Finishes crashed takes and lists the user's takes on the device. */
  recover: (userId: string) => Promise<TakeMeta[]>;
  /** Subscribes to reconnects; returns the unsubscribe. */
  onReconnect: (fn: () => void) => () => void;
  now: () => number;
  /** The error code of a failed upload; null when the user cancelled it. */
  failureCode: (err: unknown) => string | null;
  onUploaded: (take: PendingTake, result: UploadResult) => void;
  onFailed: (take: PendingTake, code: string) => void;
}

let deps: TakesDeps | null = null;
let fallbackDb: OfflineDb | null = null;
let offReconnect: (() => void) | null = null;
const inFlight = new Set<string>();

export function setTakesDeps(d: TakesDeps): void {
  deps = d;
}

function need(): TakesDeps {
  if (!deps) throw new Error("takes: deps not set");
  return deps;
}

function db(): OfflineDb {
  const d = need().db();
  if (d) return d;
  fallbackDb ??= memoryOfflineDb();
  return fallbackDb;
}

/** A take writer event (the writer client's listener). */
export function onWriterEvent(e: WriterEvent): void {
  if (e.type === "started") useTakes.setState({ recordingTakeId: e.takeId, writerError: null });
  else if (e.type === "finished") {
    useTakes.setState((s) => ({
      recordingTakeId: null,
      review: s.review.some((r) => r.takeId === e.meta.takeId) ? s.review : [...s.review, e.meta],
    }));
  } else if (e.type === "empty") useTakes.setState({ recordingTakeId: null });
  else if (e.type === "failed") useTakes.setState({ writerError: e.error });
}

/**
 * The user's takes after login (SPEC §9): unfinished takes are finished, takes neither saved nor
 * discarded go to the stop dialog ("Recover unsaved recording"), saved ones upload when online.
 */
export async function startTakes(userId: string): Promise<void> {
  const d = need();
  if (useTakes.getState().userId === userId) return;
  stopTakes();
  useTakes.setState({ ...initial(), userId });
  const [saved, onDevice] = await Promise.all([db().takes(), d.recover(userId)]);
  if (useTakes.getState().userId !== userId) return;
  const present = new Set(onDevice.map((m) => m.takeId));
  const kept: PendingTake[] = [];
  for (const p of saved) {
    if (p.userId !== userId) continue;
    // Its audio is gone (storage cleared): nothing left to upload.
    if (present.has(p.takeId))
      kept.push({ ...p, status: p.status === "error" ? "error" : "waiting" });
    else await db().deleteTake(p.takeId);
  }
  const savedIds = new Set(kept.map((p) => p.takeId));
  useTakes.setState((s) => ({
    pending: kept,
    review: [
      // Left from before (a crash, a reload, the app closed in the stop dialog): "Recover".
      ...onDevice
        .filter((m) => !savedIds.has(m.takeId) && m.userId === userId)
        .map((m) => ({ ...m, recovered: true })),
      ...s.review.filter((r) => !present.has(r.takeId)),
    ],
  }));
  offReconnect = d.onReconnect(() => {
    uploadAllTakes();
  });
  uploadAllTakes();
}

export function stopTakes(): void {
  offReconnect?.();
  offReconnect = null;
  inFlight.clear();
  fallbackDb = null;
  useTakes.setState(initial());
}

/** How a reviewed take is saved: where it goes and what it is called. */
export interface TakeChoice {
  target: UploadTarget;
  label: string;
  title: string;
  filename: string;
}

/** The stop dialog's Save: the take is queued for upload (now when online). */
export async function saveTake(meta: TakeMeta, choice: TakeChoice): Promise<PendingTake> {
  const d = need();
  const file = await d.file(meta.userId, meta.takeId);
  const take: PendingTake = {
    takeId: meta.takeId,
    userId: meta.userId,
    createdAt: meta.createdAt,
    savedAt: d.now(),
    filename: choice.filename,
    bytes: file?.size ?? 0,
    frames: meta.frames,
    channels: meta.channels,
    target: choice.target,
    songId: meta.songId,
    projectId: meta.projectId,
    label: choice.label.trim(),
    title: choice.title,
    status: "waiting",
    errorCode: null,
  };
  await db().putTake(take);
  useTakes.setState((s) => ({
    review: s.review.filter((r) => r.takeId !== meta.takeId),
    pending: [...s.pending.filter((p) => p.takeId !== take.takeId), take],
  }));
  void uploadTake(take.takeId);
  return take;
}

/** The stop dialog's Discard: the take is deleted from the device. */
export async function discardTake(meta: TakeMeta): Promise<void> {
  useTakes.setState((s) => ({ review: s.review.filter((r) => r.takeId !== meta.takeId) }));
  await need().remove(meta.userId, meta.takeId);
}

/** A saved take that will not be uploaded after all (pending row's Discard). */
export async function discardPendingTake(takeId: string): Promise<void> {
  const p = useTakes.getState().pending.find((x) => x.takeId === takeId);
  if (!p || inFlight.has(takeId)) return;
  useTakes.setState((s) => ({ pending: s.pending.filter((x) => x.takeId !== takeId) }));
  await db().deleteTake(takeId);
  await need().remove(p.userId, takeId);
}

/** Uploads every waiting take (app start, reconnect). */
export function uploadAllTakes(): void {
  for (const p of useTakes.getState().pending) {
    if (p.status !== "error") void uploadTake(p.takeId);
  }
}

function setPending(takeId: string, patch: Partial<PendingTake>): PendingTake | null {
  let out: PendingTake | null = null;
  useTakes.setState((s) => ({
    pending: s.pending.map((p) => {
      if (p.takeId !== takeId) return p;
      out = { ...p, ...patch };
      return out;
    }),
  }));
  return out;
}

/** Uploads one saved take (also the pending row's Retry); offline it keeps waiting. */
export async function uploadTake(takeId: string): Promise<void> {
  const d = need();
  const p = useTakes.getState().pending.find((x) => x.takeId === takeId);
  if (!p || inFlight.has(takeId) || !d.isOnline()) return;
  inFlight.add(takeId);
  try {
    const file = await d.file(p.userId, p.takeId);
    if (!file) {
      // The audio went (storage cleared): nothing to upload.
      useTakes.setState((s) => ({ pending: s.pending.filter((x) => x.takeId !== takeId) }));
      await db().deleteTake(takeId);
      d.onFailed(p, "TAKE_MISSING");
      return;
    }
    setPending(takeId, { status: "uploading", errorCode: null });
    const upload = new File([file], p.filename, { type: takeMimeType(file.name) });
    let result: UploadResult;
    try {
      result = await d.upload(upload, p.target, { songId: p.songId, projectId: p.projectId });
    } catch (err) {
      const code = d.failureCode(err);
      // Cancelled or offline: it waits (Retry, or the next reconnect); else the server refused.
      const waiting = code === null || code === "NETWORK";
      const next = setPending(takeId, {
        status: waiting ? "waiting" : "error",
        errorCode: waiting ? null : code,
      });
      if (next) await db().putTake(next);
      if (!waiting) d.onFailed(p, code);
      return;
    }
    if (p.label && result.trackVersionId) {
      await d.setLabel(result.trackVersionId, p.label).catch(() => undefined);
    }
    useTakes.setState((s) => ({
      pending: s.pending.filter((x) => x.takeId !== takeId),
      lastUploaded: {
        takeId,
        songId: result.songId ?? p.songId,
        trackId: result.trackId,
      },
    }));
    await db().deleteTake(takeId);
    await d.remove(p.userId, takeId);
    d.onUploaded(p, result);
  } finally {
    inFlight.delete(takeId);
  }
}

/** Takes not uploaded yet (the logout warning). */
export function unsentTakeCount(s: TakesState = useTakes.getState()): number {
  return s.pending.length + s.review.length;
}
