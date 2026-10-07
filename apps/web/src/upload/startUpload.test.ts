import type { UploadTarget } from "@bandroom/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOnlineState } from "../offline/online";
import type { DetailedError } from "tus-js-client";
import { shouldRetryUpload, startUpload, uploadFailure, UPLOAD_CANCELLED } from "./startUpload";
import { createUploadQueue, uploadQueue } from "./uploadQueue";
import { useUploads } from "./uploadStore";

interface FakeOptions {
  onProgress?: (sent: number, total: number) => void;
  onError?: (err: Error) => void;
  onSuccess?: (payload: { lastResponse: { getBody: () => string } }) => void;
}

interface FakeUpload {
  options: FakeOptions;
  start: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

const fake = vi.hoisted(() => ({
  last: null as null | FakeUpload,
  all: [] as FakeUpload[],
  previous: (): Promise<unknown[]> => Promise.resolve([]),
}));

vi.mock("tus-js-client", () => ({
  Upload: class {
    start = vi.fn();
    abort = vi.fn(() => Promise.resolve());
    resumeFromPreviousUpload = vi.fn();
    constructor(_file: File, options: FakeOptions) {
      fake.last = { options, start: this.start, abort: this.abort };
      fake.all.push(fake.last);
    }
    findPreviousUploads() {
      return fake.previous();
    }
  },
}));

const target: UploadTarget = { type: "newVersion", trackId: "t1" };
const scope = { songId: "s1", projectId: "p1" };
const file = new File(["abc"], "bass.wav");
const flush = () => new Promise((r) => setTimeout(r, 0));

function current() {
  if (!fake.last) throw new Error("no upload");
  return fake.last;
}

beforeEach(() => {
  fake.last = null;
  fake.all = [];
  fake.previous = () => Promise.resolve([]);
  useUploads.setState({ items: [] });
  useOnlineState.setState({ online: true });
});

afterEach(() => {
  // Free the queue's slots held by uploads a test left running.
  for (const item of useUploads.getState().items) item.abort?.();
  useOnlineState.setState({ online: true });
});

const ok = (u: FakeUpload) => {
  u.options.onSuccess?.({
    lastResponse: {
      getBody: () => JSON.stringify({ assetId: "a", trackId: "t", trackVersionId: "v" }),
    },
  });
};

describe("startUpload", () => {
  it("rejects with NETWORK when offline without touching the store", async () => {
    useOnlineState.setState({ online: false });
    await expect(startUpload(file, target, scope)).rejects.toMatchObject({ code: "NETWORK" });
    expect(useUploads.getState().items).toHaveLength(0);
  });

  it("resolves with the server result and removes the finished item", async () => {
    const p = startUpload(file, target, scope);
    await flush();
    expect(current().start).toHaveBeenCalled();
    current().options.onProgress?.(1, 2);
    expect(useUploads.getState().items[0]?.progress).toBe(0.5);
    const result = { assetId: "a", trackId: "t1", trackVersionId: "v" };
    current().options.onSuccess?.({ lastResponse: { getBody: () => JSON.stringify(result) } });
    await expect(p).resolves.toEqual(result);
    expect(useUploads.getState().items).toHaveLength(0);
  });

  it("rejects with UNKNOWN (and keeps an error row) when the success body is not JSON", async () => {
    const p = startUpload(file, target, scope);
    await flush();
    current().options.onSuccess?.({ lastResponse: { getBody: () => "<html>" } });
    await expect(p).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(useUploads.getState().items[0]).toMatchObject({
      status: "error",
      errorCode: "UNKNOWN",
    });
  });

  it("rejects with the server's error code and params", async () => {
    const p = startUpload(file, target, scope);
    await flush();
    const body = JSON.stringify({
      code: "QUOTA_EXCEEDED",
      message: "",
      params: { remainingBytes: 5 },
    });
    const err = Object.assign(new Error("tus"), {
      originalResponse: { getBody: () => body },
    });
    current().options.onError?.(err);
    await expect(p).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      params: { remainingBytes: 5 },
    });
    expect(useUploads.getState().items[0]?.errorCode).toBe("QUOTA_EXCEEDED");
  });

  it("settles a cancelled upload with CANCELLED and removes it", async () => {
    const p = startUpload(file, target, scope);
    await flush();
    useUploads.getState().items[0]?.abort?.();
    await expect(p).rejects.toMatchObject({ code: UPLOAD_CANCELLED });
    expect(current().abort).toHaveBeenCalledWith(true);
    expect(useUploads.getState().items).toHaveLength(0);
  });

  it("does not start when cancelled before the resume lookup finishes", async () => {
    let release: (v: unknown[]) => void = () => undefined;
    fake.previous = () => new Promise((r) => (release = r));
    const p = startUpload(file, target, scope);
    useUploads.getState().items[0]?.abort?.();
    await expect(p).rejects.toMatchObject({ code: UPLOAD_CANCELLED });
    release([]);
    await flush();
    expect(current().start).not.toHaveBeenCalled();
  });

  it("starts afresh when looking up a previous upload fails", async () => {
    fake.previous = () => Promise.reject(new Error("storage blocked"));
    void startUpload(file, target, scope).catch(() => undefined);
    await flush();
    expect(current().start).toHaveBeenCalled();
  });
});

describe("upload queue", () => {
  it("runs at most three uploads at once and starts the next when one finishes", async () => {
    const results = Array.from({ length: 5 }, () =>
      startUpload(file, target, scope).catch(() => undefined),
    );
    await flush();
    expect(fake.all).toHaveLength(5);
    expect(fake.all.filter((u) => u.start.mock.calls.length > 0)).toHaveLength(3);
    expect(useUploads.getState().items.map((i) => i.status)).toEqual([
      "uploading",
      "uploading",
      "uploading",
      "queued",
      "queued",
    ]);
    const [first] = fake.all;
    if (!first) throw new Error("no upload");
    ok(first);
    await results[0];
    await flush();
    expect(fake.all[3]?.start).toHaveBeenCalled();
    expect(fake.all[4]?.start).not.toHaveBeenCalled();
    expect(uploadQueue.stats()).toEqual({ running: 3, waiting: 1 });
  });

  it("drops a cancelled queued upload without starting it", async () => {
    const results = Array.from({ length: 4 }, () =>
      startUpload(file, target, scope).catch(() => undefined),
    );
    await flush();
    const queued = useUploads.getState().items[3];
    expect(queued?.status).toBe("queued");
    queued?.abort?.();
    await results[3];
    expect(uploadQueue.stats()).toEqual({ running: 3, waiting: 0 });
    fake.all.slice(0, 3).forEach(ok);
    await flush();
    expect(fake.all[3]?.start).not.toHaveBeenCalled();
    expect(uploadQueue.stats()).toEqual({ running: 0, waiting: 0 });
  });

  it("is first in, first out and tolerates double releases", async () => {
    const q = createUploadQueue(1);
    const order: number[] = [];
    const a = q.acquire();
    const b = q.acquire();
    const c = q.acquire();
    void b.ready.then(() => order.push(2));
    void c.ready.then(() => order.push(3));
    await a.ready;
    a.release();
    a.release();
    await flush();
    expect(order).toEqual([2]);
    b.release();
    await flush();
    expect(order).toEqual([2, 3]);
    c.release();
    expect(q.stats()).toEqual({ running: 0, waiting: 0 });
  });
});

describe("shouldRetryUpload", () => {
  const err = (status: number | null, retryAfter?: string) =>
    ({
      originalResponse:
        status === null
          ? null
          : {
              getStatus: () => status,
              getHeader: (h: string) => (h === "Retry-After" ? retryAfter : undefined),
            },
    }) as unknown as DetailedError;

  it("retries network failures, 429 and 5xx but not other client errors", () => {
    const options = { retryDelays: [0, 1000] };
    expect(shouldRetryUpload(err(null), 0, options)).toBe(true);
    expect(shouldRetryUpload(err(429), 0, options)).toBe(true);
    expect(shouldRetryUpload(err(503), 0, options)).toBe(true);
    expect(shouldRetryUpload(err(409), 0, options)).toBe(true);
    expect(shouldRetryUpload(err(403), 0, options)).toBe(false);
    expect(shouldRetryUpload(err(413), 0, options)).toBe(false);
  });

  it("waits as long as Retry-After asks, at most a minute", () => {
    const options = { retryDelays: [0, 1000, 3000] };
    shouldRetryUpload(err(429, "7"), 1, options);
    expect(options.retryDelays).toEqual([0, 7000, 3000]);
    shouldRetryUpload(err(429, "600"), 2, options);
    expect(options.retryDelays[2]).toBe(60_000);
    shouldRetryUpload(err(429, "soon"), 0, options);
    expect(options.retryDelays[0]).toBe(0);
  });

  it("does not retry while offline", () => {
    useOnlineState.setState({ online: false });
    expect(shouldRetryUpload(err(503), 0, { retryDelays: [0] })).toBe(false);
  });
});

describe("uploadFailure", () => {
  it("returns null for a cancelled upload", () => {
    expect(uploadFailure({ code: UPLOAD_CANCELLED })).toBeNull();
  });

  it("returns the code and params, falling back to UNKNOWN", () => {
    expect(uploadFailure({ code: "QUOTA_EXCEEDED", params: { admins: "x" } })).toEqual({
      code: "QUOTA_EXCEEDED",
      params: { admins: "x" },
    });
    expect(uploadFailure(new Error("boom"))).toEqual({ code: "UNKNOWN", params: null });
    expect(uploadFailure(undefined)).toEqual({ code: "UNKNOWN", params: null });
  });
});
