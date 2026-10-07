import { describe, expect, it } from "vitest";
import { FileFetcher, WINDOW_BLOCK, SparseFile, type FetchLike } from "./bytes";

describe("SparseFile", () => {
  it("stores non-overlapping pieces and reports gaps", () => {
    const f = new SparseFile();
    f.add(10, new Uint8Array([1, 2, 3, 4]));
    f.add(12, new Uint8Array([9, 9, 5, 6])); // overlaps: only 5, 6 are new
    f.add(0, new Uint8Array([7, 7]));
    expect(f.stored).toBe(8);
    expect([...(f.readAt(11, 10) ?? [])]).toEqual([2, 3, 4]);
    expect([...(f.readAt(14, 10) ?? [])]).toEqual([5, 6]);
    expect(f.readAt(5, 1)).toBeNull();
    expect(f.nextMissing(0)).toBe(2);
    expect(f.nextMissing(10)).toBe(16);
    expect(f.nextStored(2)).toBe(10);
    expect(f.nextStored(20)).toBeNull();
    f.add(8, new Uint8Array([1, 1, 1, 1])); // fills 8–9 only
    expect(f.nextMissing(8)).toBe(16);
    f.size = 16;
    expect(f.complete).toBe(false);
    f.evictBefore(9);
    expect(f.has(0)).toBe(false);
    expect(f.has(10)).toBe(true);
    expect(f.stored).toBe(8); // only 0–1 dropped (8–9 ends after 9)
    f.clear();
    expect(f.stored).toBe(0);
  });

  it("skips adjacent pieces and copies trimmed bytes", () => {
    const f = new SparseFile();
    f.add(0, new Uint8Array(10).fill(1));
    f.add(10, new Uint8Array(10).fill(2));
    // 5–25: 5–19 is stored (two adjacent pieces), only 20–24 is new.
    const chunk = new Uint8Array(20).fill(3);
    f.add(5, chunk);
    expect(f.stored).toBe(25);
    expect([...(f.readAt(18, 10) ?? [])]).toEqual([2, 2]);
    const added = f.readAt(20, 10);
    expect([...(added ?? [])]).toEqual([3, 3, 3, 3, 3]);
    expect(added?.buffer).not.toBe(chunk.buffer); // not a view of the whole chunk
    f.add(0, new Uint8Array(25)); // all stored already
    expect(f.stored).toBe(25);
    // Untrimmed pieces are kept as they came.
    const whole = new Uint8Array(4).fill(4);
    f.add(30, whole);
    expect(f.readAt(30, 4)?.buffer).toBe(whole.buffer);
    f.add(26, new Uint8Array(10).fill(5)); // fills 26–29 up to the next piece
    expect(f.nextMissing(0)).toBe(25);
    expect(f.nextMissing(26)).toBe(34);
    f.evictBefore(26);
    expect(f.stored).toBe(8);
    expect(f.has(24)).toBe(false);
    expect(f.has(26)).toBe(true);
  });
});

/** Slow in-memory server: `piece` bytes per timer tick. */
function server(
  data: Uint8Array,
  piece = 4096,
  opts: { ignoreRange?: boolean; status?: number } = {},
) {
  const requests: (string | null)[] = [];
  const fetch: FetchLike = (_url, init) => {
    const range = opts.ignoreRange ? null : (init.headers?.Range ?? null);
    requests.push(init.headers?.Range ?? null);
    const m = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    const start = m ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : data.length - 1;
    const slice = data.subarray(start, end + 1);
    let pos = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: async (ctrl) => {
        await new Promise((r) => setTimeout(r, 1));
        if (init.signal?.aborted) {
          ctrl.error(new Error("aborted"));
          return;
        }
        if (pos >= slice.length) {
          ctrl.close();
          return;
        }
        ctrl.enqueue(slice.slice(pos, pos + piece));
        pos += piece;
      },
    });
    const headers: Record<string, string> = { "content-length": String(slice.length) };
    if (m) headers["content-range"] = `bytes ${start}-${end}/${data.length}`;
    return Promise.resolve({
      status: opts.status ?? (m ? 206 : 200),
      headers: { get: (k) => headers[k] ?? null },
      body,
    });
  };
  return { fetch, requests };
}

const until = async (cond: () => boolean, ms = 10_000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 2));
  }
};

const data = new Uint8Array(1 << 20).map((_, i) => i % 251);

describe("FileFetcher", () => {
  it("downloads progressively, jumps with a Range request and fills the gap", async () => {
    const { fetch, requests } = server(data, 8192);
    const f = new FileFetcher("u", new SparseFile(), "whole", fetch, () => undefined);
    f.begin();
    await until(() => f.file.stored > 0);
    f.want(800_000);
    await until(() => f.file.has(800_000));
    expect(requests).toContain(`bytes=800000-${data.length - 1}`); // size known from the first response
    expect(f.file.readAt(800_000, 1)?.[0]).toBe(800_000 % 251);
    await until(() => f.file.complete);
    expect(f.file.size).toBe(data.length);
    expect(requests.some((r) => r?.startsWith("bytes=") && r.endsWith("-799999"))).toBe(true);
    // Near the running download: no new request.
    const g = new FileFetcher("u", new SparseFile(), "whole", fetch, () => undefined);
    g.begin();
    await until(() => g.file.stored > 0);
    const before = requests.length;
    g.want(g.file.nextMissing(0) + 1000);
    expect(requests.length).toBe(before);
    g.stop();
    f.want(5); // already there
  });

  it("downloads again after stop() and resume()", async () => {
    const { fetch, requests } = server(data, 8192);
    const f = new FileFetcher("u", new SparseFile(), "whole", fetch, () => undefined);
    f.begin();
    await until(() => f.file.stored > 0);
    f.stop();
    expect(f.file.complete).toBe(false);
    f.begin(); // stopped: no-ops
    f.want(f.file.nextMissing(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(requests.length).toBe(1);
    f.resume();
    f.begin();
    await until(() => f.file.complete);
  });

  it("reads 2 MB blocks in window mode", async () => {
    const big = new Uint8Array(WINDOW_BLOCK * 2 + 10);
    const { fetch, requests } = server(big, 65_536);
    const f = new FileFetcher("u", new SparseFile(), "window", fetch, () => undefined);
    f.begin(); // no-op in window mode
    expect(requests).toEqual([]);
    f.want(100);
    await until(() => f.file.has(WINDOW_BLOCK + 99));
    expect(requests).toEqual([`bytes=100-${WINDOW_BLOCK + 99}`]);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.file.has(WINDOW_BLOCK + 100)).toBe(false);
  });

  it("reads a whole-mode file bigger than its limit in windows", async () => {
    const big = new Uint8Array(WINDOW_BLOCK * 2 + 10);
    const { fetch, requests } = server(big, 65_536);
    const f = new FileFetcher("u", new SparseFile(), "whole", fetch, () => undefined);
    f.wholeLimit = WINDOW_BLOCK;
    f.begin();
    // The size arrives with the first response: the download stops after one block.
    await until(() => f.file.has(WINDOW_BLOCK - 1));
    expect(f.mode).toBe("window");
    await new Promise((r) => setTimeout(r, 30));
    expect(f.file.has(WINDOW_BLOCK)).toBe(false);
    expect(requests).toEqual([null]);
    f.want(WINDOW_BLOCK + 5);
    await until(() => f.file.has(2 * WINDOW_BLOCK + 4));
    expect(requests[1]).toBe(`bytes=${WINDOW_BLOCK + 5}-${2 * WINDOW_BLOCK + 4}`);
    // Later begin() calls (another load of the song) no longer download the rest.
    f.begin();
    await new Promise((r) => setTimeout(r, 20));
    expect(requests.length).toBe(2);
  });

  it("keeps a file within its limit whole", async () => {
    const { fetch } = server(data, 65_536);
    const f = new FileFetcher("u", new SparseFile(), "whole", fetch, () => undefined);
    f.wholeLimit = data.length;
    f.begin();
    await until(() => f.file.complete);
    expect(f.mode).toBe("whole");
  });

  it("copes with servers that ignore Range, and reports errors", async () => {
    const { fetch } = server(data, 1 << 18, { ignoreRange: true });
    const f = new FileFetcher("u", new SparseFile(), "whole", fetch, () => undefined);
    f.want(500_000);
    await until(() => f.file.complete);
    expect(f.file.readAt(500_000, 1)?.[0]).toBe(500_000 % 251);

    let notified = 0;
    const bad = server(data, 1024, { status: 500 });
    const e = new FileFetcher("u", new SparseFile(), "whole", bad.fetch, () => notified++, {
      baseMs: 1,
      attempts: 2,
    });
    e.begin();
    await until(() => e.error !== null);
    expect(e.error?.message).toBe("HTTP 500");
    expect(bad.requests.length).toBe(3); // the first try and two retries
    expect(notified).toBeGreaterThan(0);
  });

  it("retries network errors and 5xx with backoff, then carries on", async () => {
    const { fetch, requests } = server(data, 1 << 16);
    let calls = 0;
    // Fails twice (a dropped connection, then a 503), succeeds, then drops once more mid-way.
    const flaky: FetchLike = async (url, init) => {
      calls++;
      if (calls === 1) throw new TypeError("Failed to fetch");
      if (calls === 2) return { status: 503, headers: { get: () => null }, body: null };
      const res = await fetch(url, init);
      if (calls !== 3 || !res.body) return res;
      const reader = res.body.getReader();
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull: async (ctrl) => {
          if (n++ === 2) {
            ctrl.error(new TypeError("network error"));
            return;
          }
          const { done, value } = await reader.read();
          if (done) ctrl.close();
          else ctrl.enqueue(value);
        },
      });
      return { ...res, body };
    };
    const started = Date.now();
    const f = new FileFetcher("u", new SparseFile(), "whole", flaky, () => undefined, {
      baseMs: 20,
      attempts: 2,
    });
    f.begin();
    await until(() => f.file.complete);
    expect(f.error).toBeNull();
    expect(calls).toBe(4);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20 + 40 - 5); // backoff 20, then 40 ms
    // The last request continues where the dropped one stopped.
    expect(requests.at(-1)).toBe(`bytes=${2 * (1 << 16)}-${data.length - 1}`);
    expect([...(f.file.readAt(0, 4) ?? [])]).toEqual([0, 1, 2, 3]);
  });

  it("treats 4xx as final until retry()", async () => {
    const missing = server(data, 1024, { status: 404 });
    let notified = 0;
    const f = new FileFetcher("u", new SparseFile(), "window", missing.fetch, () => notified++, {
      baseMs: 1,
      attempts: 5,
    });
    f.want(0);
    await until(() => f.error !== null);
    expect(f.error?.message).toBe("HTTP 404");
    expect(notified).toBe(1);
    f.want(0); // final: no new request
    await new Promise((r) => setTimeout(r, 10));
    expect(missing.requests.length).toBe(1);
    f.retry();
    expect(f.error).toBeNull();
    f.want(0);
    await until(() => f.error !== null);
    expect(missing.requests.length).toBe(2);
  });

  it("does not retry after stop()", async () => {
    const bad = server(data, 1024, { status: 503 });
    const f = new FileFetcher("u", new SparseFile(), "whole", bad.fetch, () => undefined, {
      baseMs: 10,
      attempts: 5,
    });
    f.begin();
    await until(() => bad.requests.length === 1);
    await new Promise((r) => setTimeout(r, 2));
    f.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(bad.requests.length).toBe(1);
    expect(f.error).toBeNull();
  });
});
