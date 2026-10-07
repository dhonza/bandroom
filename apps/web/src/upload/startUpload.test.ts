import type { UploadTarget } from "@bandroom/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOnlineState } from "../offline/online";
import { startUpload, uploadFailure, UPLOAD_CANCELLED } from "./startUpload";
import { useUploads } from "./uploadStore";

interface FakeOptions {
  onProgress?: (sent: number, total: number) => void;
  onError?: (err: Error) => void;
  onSuccess?: (payload: { lastResponse: { getBody: () => string } }) => void;
}

const fake = vi.hoisted(() => ({
  last: null as null | {
    options: FakeOptions;
    start: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  },
  previous: (): Promise<unknown[]> => Promise.resolve([]),
}));

vi.mock("tus-js-client", () => ({
  Upload: class {
    start = vi.fn();
    abort = vi.fn(() => Promise.resolve());
    resumeFromPreviousUpload = vi.fn();
    constructor(_file: File, options: FakeOptions) {
      fake.last = { options, start: this.start, abort: this.abort };
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
  fake.previous = () => Promise.resolve([]);
  useUploads.setState({ items: [] });
  useOnlineState.setState({ online: true });
});

afterEach(() => {
  useOnlineState.setState({ online: true });
});

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
