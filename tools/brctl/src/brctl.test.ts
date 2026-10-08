import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getWhoami, listProjects } from "@bandroom/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, CHUNK_BYTES, RemoteError } from "./client";
import { run, UsageError, type Options } from "./commands";
import { ConfigError, loadRemoteConfig, parseEnvFile } from "./config";
import { formatAgo, formatBytes, parseSince, table } from "./format";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "brctl-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("config", () => {
  it("parses env files literally", () => {
    expect(
      parseEnvFile(
        `# c\nexport BANDROOM_URL="https://x.test/sub/"\nBANDROOM_API_KEY='brk_$(id)'\nbad line\n`,
      ),
    ).toEqual({ BANDROOM_URL: "https://x.test/sub/", BANDROOM_API_KEY: "brk_$(id)" });
  });

  it("prefers the environment and checks the URL", () => {
    fs.writeFileSync(
      path.join(dir, ".env.remote"),
      "BANDROOM_URL=https://a.test/x/\nBANDROOM_API_KEY=k1\n",
    );
    expect(loadRemoteConfig({}, dir)).toEqual({ url: "https://a.test/x", apiKey: "k1" });
    expect(loadRemoteConfig({ BANDROOM_API_KEY: "k2" }, dir).apiKey).toBe("k2");
    expect(loadRemoteConfig({ BANDROOM_URL: "http://localhost:5180" }, dir).url).toBe(
      "http://localhost:5180",
    );
    expect(() => loadRemoteConfig({ BANDROOM_URL: "http://example.test" }, dir)).toThrow(
      ConfigError,
    );
    expect(() => loadRemoteConfig({ BANDROOM_URL: "ftp://a" }, dir)).toThrow(ConfigError);
    expect(() => loadRemoteConfig({ BANDROOM_URL: "nope" }, dir)).toThrow(ConfigError);
    expect(() => loadRemoteConfig({}, path.join(dir, "none"))).toThrow(ConfigError);
  });
});

describe("format", () => {
  it("formats sizes, ages, durations and tables", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(null)).toBe("-");
    expect(formatAgo(1000, 31_000)).toBe("30s ago");
    expect(formatAgo(0, 7200_000)).toBe("2h ago");
    expect(formatAgo(0, 3 * 86_400_000)).toBe("3d ago");
    expect(formatAgo(10_000, 0)).toBe("in the future");
    expect(parseSince("24h", 100_000_000)).toBe(100_000_000 - 86_400_000);
    expect(parseSince("1791000000000")).toBe(1791000000000);
    expect(parseSince("2026-10-08T00:00:00Z")).toBe(Date.parse("2026-10-08T00:00:00Z"));
    expect(() => parseSince("soon")).toThrow(/since/);
    expect(
      table(
        ["a", "bb"],
        [
          ["x", null],
          ["long value", 3],
        ],
        5,
      ),
    ).toBe("a      bb\n-----  --\nx      -\nlong…  3");
  });
});

/** A fake server answering by method + path. */
function fakeServer(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  const calls: Request[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    const req = new Request(input instanceof Request ? input : String(input), init);
    calls.push(req);
    const url = new URL(req.url);
    const handler = routes[`${req.method} ${url.pathname}`];
    return handler
      ? handler(req)
      : Response.json({ code: "NOT_FOUND", message: "nope" }, { status: 404 });
  };
  return { calls, doFetch };
}

const config = { url: "https://band.test/sub", apiKey: "brk_test" };
const whoami = {
  user: { id: "u", username: "ann", displayName: "Ann", globalRole: "admin" },
  key: { id: "k", name: "claude", scopes: ["read"], expiresAt: null },
  server: { version: "v0.5.0", maxUploadBytes: 100 },
  quota: { usedBytes: 10, quotaBytes: null },
};

describe("client", () => {
  it("calls contracts with the key and parses responses and errors", async () => {
    const s = fakeServer({
      "GET /sub/api/v1/whoami": () => Response.json(whoami),
      "GET /sub/api/v1/projects": () =>
        Response.json({ code: "API_KEY_SCOPE", message: "no" }, { status: 403 }),
    });
    const c = new Client(config, s.doFetch);
    expect((await c.call(getWhoami)).user.username).toBe("ann");
    expect(s.calls[0]?.headers.get("authorization")).toBe("Bearer brk_test");
    const err = await c
      .call(listProjects, { query: { archived: "true" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe("API_KEY_SCOPE");
    expect(new URL(s.calls[1]?.url ?? "").searchParams.get("archived")).toBe("true");
  });

  it("uploads with tus in chunks", async () => {
    const file = path.join(dir, "take.wav");
    fs.writeFileSync(file, Buffer.alloc(CHUNK_BYTES + 10, 1));
    const offsets: string[] = [];
    const s = fakeServer({
      "POST /sub/api/v1/uploads": (req) => {
        expect(req.headers.get("upload-length")).toBe(String(CHUNK_BYTES + 10));
        expect(req.headers.get("upload-metadata")).toContain(`filename ${btoa("take.wav")}`);
        return new Response(null, {
          status: 201,
          headers: { Location: "/sub/api/v1/uploads/abc" },
        });
      },
      "PATCH /sub/api/v1/uploads/abc": (req) => {
        offsets.push(req.headers.get("upload-offset") ?? "");
        return offsets.length === 1
          ? new Response(null, { status: 204 })
          : Response.json({ assetId: "a", trackId: "t", trackVersionId: "v" });
      },
    });
    const progress: number[] = [];
    const r = await new Client(config, s.doFetch).upload(
      file,
      { type: "newTrack", songId: "s", name: "Take" },
      (sent) => progress.push(sent),
    );
    expect(r.trackVersionId).toBe("v");
    expect(offsets).toEqual(["0", String(CHUNK_BYTES)]);
    expect(progress).toEqual([CHUNK_BYTES, CHUNK_BYTES + 10]);
  });

  it("reports a refused upload creation", async () => {
    const file = path.join(dir, "x.wav");
    fs.writeFileSync(file, "x");
    const s = fakeServer({
      "POST /sub/api/v1/uploads": () =>
        new Response(JSON.stringify({ code: "DUPLICATE_VERSION", message: "same" }), {
          status: 409,
        }),
    });
    const err = await new Client(config, s.doFetch)
      .upload(file, { type: "newVersion", trackId: "t" })
      .catch((e: unknown) => e);
    expect((err as RemoteError).code).toBe("DUPLICATE_VERSION");
  });
});

describe("commands", () => {
  const opts = (o: Partial<Options> = {}): Options => ({
    json: false,
    wait: false,
    cwd: dir,
    ...o,
  });

  it("prints whoami as text and json", async () => {
    const s = fakeServer({ "GET /sub/api/v1/whoami": () => Response.json(whoami) });
    const lines: string[] = [];
    await run(new Client(config, s.doFetch), ["whoami"], opts(), (l) => lines.push(l));
    expect(lines[0]).toContain("Ann (ann, admin)");
    await run(new Client(config, s.doFetch), ["whoami"], opts({ json: true }), (l) =>
      lines.push(l),
    );
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ user: { username: "ann" } });
  });

  it("uploads a new version with its SHA-256", async () => {
    const file = path.join(dir, "mix.wav");
    fs.writeFileSync(file, "abc");
    let target: unknown;
    const s = fakeServer({
      "POST /sub/api/v1/uploads": (req) => {
        const meta = req.headers.get("upload-metadata") ?? "";
        target = JSON.parse(atob(meta.split(",")[1]?.split(" ")[1] ?? ""));
        return new Response(null, { status: 201, headers: { Location: "uploads/u1" } });
      },
      "PATCH /sub/api/v1/uploads/u1": () =>
        Response.json({ assetId: "a", trackId: "t", trackVersionId: "v" }),
    });
    const lines: string[] = [];
    await run(new Client(config, s.doFetch), ["upload", "mix.wav"], opts({ track: "t" }), (l) =>
      lines.push(l),
    );
    expect(target).toEqual({
      type: "newVersion",
      trackId: "t",
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
    expect(lines.at(-1)).toContain("version v");
  });

  it("checks usage", async () => {
    const c = new Client(config, fakeServer({}).doFetch);
    await expect(run(c, ["nope"], opts(), () => undefined)).rejects.toThrow(UsageError);
    await expect(run(c, ["upload", "f"], opts(), () => undefined)).rejects.toThrow(UsageError);
    await expect(run(c, ["update", "request", "1.0"], opts(), () => undefined)).rejects.toThrow(
      UsageError,
    );
    await expect(run(c, ["jobs"], opts({ status: "weird" }), () => undefined)).rejects.toThrow(
      UsageError,
    );
  });
});
