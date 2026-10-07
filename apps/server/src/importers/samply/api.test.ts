import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { FileTooLargeError, SamplyApiError, SamplyClient } from "./api";
import project0 from "./fixtures/project-0-all.json";
import projects from "./fixtures/projects.json";

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const client = (fn: typeof fetch) =>
  new SamplyClient({ apiKey: "key-123", fetch: fn, minIntervalMs: 0, backoffMs: 1 });

describe("SamplyClient", () => {
  it("sends the bearer token and parses recorded responses", async () => {
    const f = fakeFetch((url) => (url.endsWith("/projects") ? json(projects) : json(project0)));
    const c = client(f.fn);
    const ps = await c.listProjects();
    expect(ps).toHaveLength(projects.length);
    const boxes = await c.listBoxes(ps[0]?.id ?? "");
    expect(boxes.some((b) => b.object === "folder")).toBe(true);
    expect(f.calls[0]?.url).toBe("https://samply.app/api/v0/projects");
    expect((f.calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer key-123",
    );
  });

  it("retries 429 (honoring Retry-After) and 5xx, then succeeds", async () => {
    let n = 0;
    const f = fakeFetch(() => {
      n++;
      if (n === 1) return json({}, 429, { "retry-after": "0" });
      if (n === 2) return json({}, 503);
      return json([]);
    });
    await expect(client(f.fn).listComments("p", "f")).resolves.toEqual([]);
    expect(n).toBe(3);
  });

  it("does not retry auth errors and flags them as unauthorized", async () => {
    const f = fakeFetch(() => json({ error: "bad key" }, 401));
    const err = await client(f.fn)
      .listProjects()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SamplyApiError);
    expect((err as SamplyApiError).unauthorized).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it("gives up after maxRetries on persistent 5xx", async () => {
    const f = fakeFetch(() => json({}, 500));
    const c = new SamplyClient({
      apiKey: "k",
      fetch: f.fn,
      minIntervalMs: 0,
      backoffMs: 1,
      maxRetries: 2,
    });
    await expect(c.listProjects()).rejects.toMatchObject({ status: 500 });
    expect(f.calls).toHaveLength(3);
  });

  it("streams a download to disk with its sha256, and reads sizes via HEAD", async () => {
    const body = Buffer.from("RIFF....WAVEfmt fake audio bytes".repeat(1000));
    const f = fakeFetch((_url, init) =>
      init?.method === "HEAD"
        ? new Response(null, {
            headers: { "content-length": String(body.length), "content-type": "audio/x-wav" },
          })
        : new Response(body, { headers: { "content-type": "audio/x-wav" } }),
    );
    const c = client(f.fn);
    await expect(c.head("https://files.example/x")).resolves.toEqual({
      sizeBytes: body.length,
      contentType: "audio/x-wav",
    });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "samply-dl-"));
    const dest = path.join(dir, "x.wav");
    const res = await c.download("https://files.example/x", dest);
    expect(res.sizeBytes).toBe(body.length);
    expect(res.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect((await fs.readFile(dest)).equals(body)).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("refuses files over the size limit and lets the caller veto a download (review M13)", async () => {
    const body = Buffer.alloc(5000, 1);
    const withLength = new Map([["/declared", true]]);
    const f = fakeFetch((url) =>
      withLength.get(new URL(url).pathname)
        ? new Response(body, { headers: { "content-length": String(body.length) } })
        : // No Content-Length: the limit applies while streaming.
          new Response(
            Readable.toWeb(
              Readable.from([body.subarray(0, 3000), body.subarray(3000)]),
            ) as ReadableStream,
          ),
    );
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "samply-dl-"));
    const dest = path.join(dir, "x.bin");
    try {
      const declared: (number | null)[] = [];
      const limited = new SamplyClient({
        apiKey: "k",
        fetch: f.fn,
        minIntervalMs: 0,
        downloadLimits: {
          maxBytes: 4000,
          admit: (bytes) => {
            declared.push(bytes);
            return Promise.resolve();
          },
        },
      });
      await expect(limited.download("https://files.example/declared", dest)).rejects.toBeInstanceOf(
        FileTooLargeError,
      );
      expect(declared).toEqual([]); // refused before asking
      await expect(limited.download("https://files.example/streamed", dest)).rejects.toBeInstanceOf(
        FileTooLargeError,
      );
      expect(declared).toEqual([null]);

      const vetoed = new SamplyClient({
        apiKey: "k",
        fetch: f.fn,
        minIntervalMs: 0,
        downloadLimits: { admit: () => Promise.reject(new Error("disk full")) },
      });
      await fs.rm(dest, { force: true });
      await expect(vetoed.download("https://files.example/declared", dest)).rejects.toThrow(
        "disk full",
      );
      await expect(fs.access(dest)).rejects.toThrow(); // nothing written
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
