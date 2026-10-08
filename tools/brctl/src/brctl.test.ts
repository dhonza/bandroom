import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getWhoami, listProjects } from "@bandroom/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, CHUNK_BYTES, RemoteError } from "./client";
import { run, UsageError, type Options } from "./commands";
import { ConfigError, loadRemoteConfig, parseEnvFile } from "./config";
import { PartialFailureError, SongExistsError } from "./folders";
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

describe("folder uploads", () => {
  const opts = (o: Partial<Options> = {}): Options => ({
    json: false,
    wait: false,
    cwd: dir,
    ...o,
  });
  const access = { role: "admin", capabilities: [] };
  const project = (id: string, name: string) => ({
    id,
    name,
    color: "red",
    songCount: 0,
    updatedAt: 1,
    archivedAt: null,
    imageHash: null,
    visibility: "full",
    access,
    description: "",
    downloadPolicy: "all",
    ownerId: "u",
    ownerDisplayName: "Ann",
    createdAt: 1,
  });
  const song = (id: string, projectId: string, title: string) => ({
    id,
    projectId,
    title,
    subtitle: "",
    key: "",
    sortOrder: 0,
    updatedAt: 1,
    access,
  });
  const write = (rel: string, data = "x") => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
  };

  /** A server that creates projects and songs and accepts tus uploads (one PATCH each). */
  function bandServer(existing: { id: string; title: string }[] = [], failFile?: string) {
    const created: { kind: string; body: Record<string, unknown>; parent?: string }[] = [];
    const uploads: { file: string; target: Record<string, unknown> }[] = [];
    let n = 0;
    const s = fakeServer({
      "POST /sub/api/v1/projects": async (req) => {
        const body = (await req.json()) as { name: string };
        created.push({ kind: "project", body });
        return Response.json({ project: project("p-new", body.name) });
      },
      "GET /sub/api/v1/projects/p1/songs": () =>
        Response.json({ songs: existing.map((e) => song(e.id, "p1", e.title)) }),
      ...Object.fromEntries(
        ["p1", "p-new"].map((p) => [
          `POST /sub/api/v1/projects/${p}/songs`,
          async (req: Request) => {
            const body = (await req.json()) as { title: string };
            created.push({ kind: "song", body, parent: p });
            return Response.json({ song: song(`s${created.length}`, p, body.title) });
          },
        ]),
      ),
      "POST /sub/api/v1/uploads": (req) => {
        const meta: Record<string, string> = Object.fromEntries(
          (req.headers.get("upload-metadata") ?? "").split(",").map((kv): [string, string] => {
            const [k = "", v = ""] = kv.split(" ");
            return [k, atob(v)];
          }),
        );
        const file = meta.filename ?? "";
        if (file === failFile)
          return Response.json({ code: "QUOTA_EXCEEDED", message: "full" }, { status: 413 });
        uploads.push({ file, target: JSON.parse(meta.target ?? "{}") as Record<string, unknown> });
        n++;
        return new Response(null, { status: 201, headers: { Location: `uploads/u${n}` } });
      },
    });
    const doFetch: typeof fetch = async (input, init) => {
      const req = new Request(input instanceof Request ? input : String(input), init);
      const m = /\/uploads\/u(\d+)$/.exec(new URL(req.url).pathname);
      if (req.method === "PATCH" && m)
        return Response.json({
          assetId: `a${m[1]}`,
          trackId: `t${m[1]}`,
          trackVersionId: `v${m[1]}`,
        });
      return s.doFetch(input, init);
    };
    return { calls: s.calls, created, uploads, client: new Client(config, doFetch) };
  }

  it("creates a project and a song and prints their ids", async () => {
    const b = bandServer();
    const lines: string[] = [];
    await run(b.client, ["create-project", "New", "Album"], opts({ description: "d" }), (l) =>
      lines.push(l),
    );
    await run(b.client, ["create-song", "p1", "First", "Song"], opts(), (l) => lines.push(l));
    expect(b.created).toEqual([
      { kind: "project", body: { name: "New Album", description: "d" } },
      { kind: "song", body: { title: "First Song" }, parent: "p1" },
    ]);
    expect(lines).toEqual(["p-new", "s2"]);
  });

  it("uploads a song folder: sorted, named like the web drop, non-audio skipped", async () => {
    write("Demo/Demo_Drums.wav");
    write("Demo/Demo_Bass.flac");
    write("Demo/Demo_Vox 10.wav");
    write("Demo/Demo_Vox 2.wav");
    write("Demo/notes.txt");
    write("Demo/stems.zip");
    write("Demo/.DS_Store");
    write("Demo/sub/x.wav");
    const b = bandServer();
    const lines: string[] = [];
    await run(b.client, ["upload-song", "Demo"], opts({ project: "p1", json: true }), (l) =>
      lines.push(l),
    );
    expect(b.created).toEqual([{ kind: "song", body: { title: "Demo" }, parent: "p1" }]);
    expect(b.uploads.map((u) => [u.file, u.target.name])).toEqual([
      ["Demo_Bass.flac", "Bass"],
      ["Demo_Drums.wav", "Drums"],
      ["Demo_Vox 2.wav", "Vox 2"],
      ["Demo_Vox 10.wav", "Vox 10"],
    ]);
    expect(b.uploads[0]?.target).toEqual({ type: "newTrack", songId: "s1", name: "Bass" });
    const summary = JSON.parse(lines.at(-1) ?? "") as { skipped: { path: string }[] };
    expect(summary.skipped.map((x) => x.path)).toEqual(["notes.txt", "stems.zip", "sub"]);
  });

  it("refuses a song title the project already has", async () => {
    write("Demo/a.wav");
    const b = bandServer([{ id: "old", title: "demo" }]);
    const err = await run(
      b.client,
      ["upload-song", "Demo"],
      opts({ project: "p1" }),
      () => undefined,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SongExistsError);
    expect(String(err)).toContain("--song old");
    expect(b.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("uploads a project folder: subfolders are songs, loose files one song", async () => {
    write("Gig/loose.wav");
    write("Gig/B Song/x_gtr.wav");
    write("Gig/B Song/x_keys.wav");
    write("Gig/A Song/one.mp3");
    write("Gig/Empty/readme.md");
    const b = bandServer();
    await run(b.client, ["upload-project", "Gig"], opts(), () => undefined);
    expect(b.created.map((c) => [c.kind, c.body.name ?? c.body.title, c.parent])).toEqual([
      ["project", "Gig", undefined],
      ["song", "Gig", "p-new"],
      ["song", "A Song", "p-new"],
      ["song", "B Song", "p-new"],
    ]);
    expect(b.uploads.map((u) => u.target.name)).toEqual(["loose", "one", "gtr", "keys"]);
  });

  it("reuses a project with --project and passes the upload options", async () => {
    write("Gig/A/a.wav");
    const b = bandServer([{ id: "s0", title: "Other" }]);
    await run(
      b.client,
      ["upload-project", "Gig"],
      opts({ project: "p1", quality: "low", lossyOnly: true }),
      () => undefined,
    );
    expect(b.created).toEqual([{ kind: "song", body: { title: "A" }, parent: "p1" }]);
    expect(b.uploads[0]?.target).toMatchObject({
      type: "newTrack",
      options: { lossyOnly: true, quality: "low" },
    });
    await expect(
      run(b.client, ["upload-project", "Gig"], opts({ quality: "ultra" }), () => undefined),
    ).rejects.toThrow(UsageError);
  });

  it("makes no writes on --dry-run", async () => {
    write("Gig/A/Song_Bass.wav", "1234");
    write("Gig/A/Song_Drums.wav");
    const b = bandServer();
    const lines: string[] = [];
    await run(b.client, ["upload-project", "Gig"], opts({ dryRun: true }), (l) => lines.push(l));
    await run(b.client, ["upload-song", "Gig/A"], opts({ dryRun: true, project: "p1" }), (l) =>
      lines.push(l),
    );
    await run(b.client, ["create-project", "X"], opts({ dryRun: true }), (l) => lines.push(l));
    expect(b.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(lines[0]).toContain('song "A" (2 track(s))');
    expect(lines[0]).toContain("Bass <- Song_Bass.wav (4 B)");
  });

  it("continues after a failed file and exits non-zero with the failures", async () => {
    write("Demo/a.wav");
    write("Demo/b.wav");
    write("Demo/c.wav");
    const b = bandServer([], "b.wav");
    const lines: string[] = [];
    const err = await run(b.client, ["upload-song", "Demo"], opts({ project: "p1" }), (l) =>
      lines.push(l),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialFailureError);
    expect((err as PartialFailureError).failures).toEqual([
      { file: path.join(dir, "Demo/b.wav"), error: "QUOTA_EXCEEDED: full" },
    ]);
    expect(b.uploads.map((u) => u.file)).toEqual(["a.wav", "c.wav"]);
    expect(lines.at(-1)).toContain("2 track(s) uploaded to 1 song(s)");
  });
});
