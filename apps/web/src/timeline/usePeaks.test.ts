import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(msg: unknown) {
    this.posted.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
}

beforeEach(() => {
  vi.resetModules();
  FakeWorker.last = null;
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadPeaks", () => {
  it.each(["onerror", "onmessageerror"] as const)(
    "fails pending requests and falls back to the main thread on %s",
    async (handler) => {
      const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 404 })));
      vi.stubGlobal("fetch", fetchMock);
      const { loadPeaks } = await import("./usePeaks");
      const pending = loadPeaks("aaa");
      const w = FakeWorker.last;
      expect(w?.posted).toHaveLength(1);
      if (handler === "onerror") w?.onerror?.(new Event("error"));
      else w?.onmessageerror?.(new MessageEvent("messageerror"));
      await expect(pending).rejects.toThrow("peaks worker failed");
      expect(w?.terminated).toBe(true);
      // The next load parses on the main thread (and is not served the failed result).
      await expect(loadPeaks("aaa")).rejects.toThrow("HTTP 404");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(w?.posted).toHaveLength(1);
    },
  );
});
