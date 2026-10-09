import type { UploadResult, UploadTarget } from "@bandroom/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryOfflineDb, type PendingTake } from "../offline/db";
import {
  discardPendingTake,
  discardTake,
  onWriterEvent,
  saveTake,
  setTakesDeps,
  startTakes,
  stopTakes,
  unsentTakeCount,
  uploadTake,
  useTakes,
  type TakesDeps,
} from "./takes";
import type { TakeMeta } from "./takeTypes";

const meta = (id: string, over: Partial<TakeMeta> = {}): TakeMeta => ({
  v: 1,
  takeId: id,
  userId: "u1",
  mode: "song",
  songId: "s1",
  projectId: "p1",
  startFrame: 0,
  latencyFrames: 0,
  trimmedFrames: 0,
  channels: 1,
  frames: 48_000,
  status: "finished",
  endedBy: "user",
  gapFrames: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const target: UploadTarget = {
  type: "newTrack",
  songId: "s1",
  name: "Recording 1",
  source: "recording",
  offsetSamples: 480,
};

function setup() {
  const db = memoryOfflineDb();
  const files = new Map<string, File>();
  let online = true;
  let reconnect: (() => void) | null = null;
  let nextUpload: () => Promise<UploadResult> = () =>
    Promise.resolve({ assetId: "a", trackId: "t9", trackVersionId: "v9" });
  const calls = {
    uploads: [] as { name: string; target: UploadTarget }[],
    labels: [] as [string, string][],
    removed: [] as string[],
    uploaded: [] as string[],
    failed: [] as [string, string][],
  };
  const deps: TakesDeps = {
    db: () => db,
    file: (_u, id) => Promise.resolve(files.get(id) ?? null),
    remove: (_u, id) => {
      files.delete(id);
      calls.removed.push(id);
      return Promise.resolve();
    },
    upload: (file, t) => {
      calls.uploads.push({ name: file.name, target: t });
      return nextUpload();
    },
    setLabel: (id, label) => {
      calls.labels.push([id, label]);
      return Promise.resolve();
    },
    isOnline: () => online,
    recover: () => Promise.resolve([...files.keys()].map((id) => meta(id))),
    onReconnect: (fn) => {
      reconnect = fn;
      return () => {
        reconnect = null;
      };
    },
    now: () => 100,
    failureCode: (err) => (err as { code?: string }).code ?? "UNKNOWN",
    onUploaded: (p) => calls.uploaded.push(p.takeId),
    onFailed: (p, code) => calls.failed.push([p.takeId, code]),
  };
  setTakesDeps(deps);
  const addFile = (id: string) => files.set(id, new File([new Uint8Array(1234)], `${id}.flac`));
  return {
    db,
    files,
    calls,
    addFile,
    setOnline: (v: boolean) => {
      online = v;
    },
    reconnect: () => reconnect?.(),
    failNext: (code: string) => {
      nextUpload = () => Promise.reject(Object.assign(new Error(code), { code }));
    },
    succeedNext: (r: UploadResult) => {
      nextUpload = () => Promise.resolve(r);
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("takes", () => {
  beforeEach(() => {
    stopTakes();
  });

  it("puts finished takes up for review and saves them for upload", async () => {
    const s = setup();
    await startTakes("u1");
    s.addFile("t1");
    onWriterEvent({ type: "started", takeId: "t1" });
    expect(useTakes.getState().recordingTakeId).toBe("t1");
    onWriterEvent({ type: "finished", meta: meta("t1") });
    expect(useTakes.getState().review.map((r) => r.takeId)).toEqual(["t1"]);
    expect(unsentTakeCount()).toBe(1);

    await saveTake(meta("t1"), {
      target,
      label: " take one ",
      title: "Recording 1",
      filename: "Recording 1.flac",
    });
    await settle();
    expect(s.calls.uploads).toEqual([{ name: "Recording 1.flac", target }]);
    expect(s.calls.labels).toEqual([["v9", "take one"]]);
    expect(s.calls.removed).toEqual(["t1"]);
    expect(s.calls.uploaded).toEqual(["t1"]);
    expect(useTakes.getState()).toMatchObject({
      review: [],
      pending: [],
      lastUploaded: { takeId: "t1", songId: "s1", trackId: "t9" },
    });
    expect(await s.db.takes()).toEqual([]);
  });

  it("keeps a take offline and uploads it on reconnect", async () => {
    const s = setup();
    s.setOnline(false);
    await startTakes("u1");
    s.addFile("t2");
    await saveTake(meta("t2", { mode: "project", songId: null }), {
      target: { type: "newSong", projectId: "p1", title: "Rec", trackName: "Recording" },
      label: "",
      title: "Rec",
      filename: "Rec.flac",
    });
    await settle();
    expect(s.calls.uploads).toEqual([]);
    expect(useTakes.getState().pending[0]).toMatchObject({ status: "waiting", bytes: 1234 });
    expect((await s.db.takes()).map((p) => p.takeId)).toEqual(["t2"]);

    s.setOnline(true);
    s.succeedNext({ assetId: "a", trackId: "t", trackVersionId: "v", songId: "new-song" });
    s.reconnect();
    await settle();
    await settle();
    expect(s.calls.uploads).toHaveLength(1);
    expect(s.calls.labels).toEqual([]);
    expect(useTakes.getState().lastUploaded).toMatchObject({ takeId: "t2", songId: "new-song" });
  });

  it("restores saved takes and recovers unsaved ones at start", async () => {
    const s = setup();
    s.addFile("saved");
    s.addFile("unsaved");
    const pending: PendingTake = {
      takeId: "saved",
      userId: "u1",
      createdAt: 1,
      savedAt: 2,
      filename: "x.flac",
      bytes: 1,
      frames: 1,
      channels: 1,
      target,
      songId: "s1",
      projectId: "p1",
      label: "",
      title: "Recording 1",
      status: "uploading",
      errorCode: null,
    };
    await s.db.putTake(pending);
    await s.db.putTake({ ...pending, takeId: "gone" });
    s.setOnline(false);
    await startTakes("u1");
    const st = useTakes.getState();
    // An upload cut by closing the app waits again; a take whose audio is gone is dropped.
    expect(st.pending.map((p) => [p.takeId, p.status])).toEqual([["saved", "waiting"]]);
    expect(st.review.map((r) => [r.takeId, r.recovered])).toEqual([["unsaved", true]]);
    expect((await s.db.takes()).map((p) => p.takeId)).toEqual(["saved"]);
  });

  it("marks refused uploads, retries and discards", async () => {
    const s = setup();
    await startTakes("u1");
    s.addFile("t3");
    s.failNext("QUOTA_EXCEEDED");
    await saveTake(meta("t3"), { target, label: "", title: "R", filename: "R.flac" });
    await settle();
    expect(useTakes.getState().pending[0]).toMatchObject({
      status: "error",
      errorCode: "QUOTA_EXCEEDED",
    });
    expect(s.calls.failed).toEqual([["t3", "QUOTA_EXCEEDED"]]);
    expect(s.files.has("t3")).toBe(true);

    s.failNext("NETWORK");
    await uploadTake("t3");
    expect(useTakes.getState().pending[0]).toMatchObject({ status: "waiting", errorCode: null });

    await discardPendingTake("t3");
    expect(useTakes.getState().pending).toEqual([]);
    expect(s.files.has("t3")).toBe(false);
    expect(await s.db.takes()).toEqual([]);
  });

  it("discards a reviewed take and drops a saved one whose audio is gone", async () => {
    const s = setup();
    await startTakes("u1");
    s.addFile("t4");
    onWriterEvent({ type: "finished", meta: meta("t4") });
    await discardTake(meta("t4"));
    expect(useTakes.getState().review).toEqual([]);
    expect(s.files.has("t4")).toBe(false);

    await saveTake(meta("t5"), { target, label: "", title: "R", filename: "R.flac" });
    await settle();
    expect(s.calls.failed).toEqual([["t5", "TAKE_MISSING"]]);
    expect(useTakes.getState().pending).toEqual([]);
  });

  it("reports writer failures and empty takes", async () => {
    setup();
    await startTakes("u1");
    onWriterEvent({ type: "started", takeId: "x" });
    onWriterEvent({ type: "failed", error: "QuotaExceededError", meta: null });
    expect(useTakes.getState().writerError).toBe("QuotaExceededError");
    onWriterEvent({ type: "empty" });
    expect(useTakes.getState().recordingTakeId).toBeNull();
    vi.restoreAllMocks();
  });
});
