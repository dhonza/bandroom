import fs from "node:fs";
import type { SamplyBox, SamplyComment, SamplyInsight, SamplyProject } from "../api";

/**
 * In-memory Samply (SPEC §17: "tested without a live account"). Serves the API shapes verified
 * against the live service plus signed file URLs. Use `fetch` directly in tests, or put
 * `handle` behind an HTTP server for e2e.
 */
export interface FakeFile {
  /** Local file served as the download body. */
  path: string;
  contentType: string;
}

export interface FakeSamplyState {
  apiKey: string;
  projects: SamplyProject[];
  boxes: Record<string, SamplyBox[]>;
  comments: Record<string, SamplyComment[]>;
  insights: Record<string, SamplyInsight[]>;
  files: Record<string, FakeFile>;
}

export const FAKE_FILES_ORIGIN = "https://files.samply.test";

export function createFakeSamply(state: FakeSamplyState, apiBase = "https://samply.test/api/v0") {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const handle = (url: string, init?: RequestInit): Response => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.startsWith(FAKE_FILES_ORIGIN)) {
      const id = decodeURIComponent(url.slice(FAKE_FILES_ORIGIN.length + 1));
      const file = state.files[id];
      if (!file) return new Response("not found", { status: 404 });
      const size = fs.statSync(file.path).size;
      const headers = { "content-type": file.contentType, "content-length": String(size) };
      if (method === "HEAD") return new Response(null, { headers });
      return new Response(fs.readFileSync(file.path), { headers });
    }
    if (!url.startsWith(apiBase)) return new Response("unknown host", { status: 502 });
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${state.apiKey}`) return json({ error: "unauthorized" }, 401);
    const route = new URL(url).pathname.slice(new URL(apiBase).pathname.length);
    const parts = route.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "projects") return json({ error: "not found" }, 404);
    if (parts.length === 1) return json(state.projects);
    const projectId = parts[1] ?? "";
    if (!state.projects.some((p) => p.id === projectId)) return json({ error: "not found" }, 404);
    if (parts[2] === "all") return json(state.boxes[projectId] ?? []);
    if (parts[2] === "insights") return json(state.insights[projectId] ?? []);
    if (parts[2] === "files" && parts[3]) {
      const fileId = parts[3];
      if (parts[4] === "comments") return json(state.comments[fileId] ?? []);
      if (parts[4] === "download")
        return json({
          url: `${FAKE_FILES_ORIGIN}/${encodeURIComponent(fileId)}`,
          expires: Date.now() + 3600_000,
        });
    }
    return json({ error: "not found" }, 404);
  };

  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(handle(url, init));
  }) as typeof fetch;

  return { state, calls, handle, fetch: fetchFn, apiBase };
}

let seq = 0;
/** A box with defaults, for building trees in tests. */
export function fakeBox(
  object: SamplyBox["object"],
  name: string,
  extra: Partial<SamplyBox> = {},
): SamplyBox {
  seq++;
  return {
    id: `box${String(seq).padStart(4, "0")}fake`,
    object,
    name,
    color: "",
    timeCreated: 1_700_000_000_000 + seq * 1000,
    children: [],
    trashed: false,
    hidden: false,
    ...extra,
  };
}

export const childrenOf = (...boxes: SamplyBox[]) => boxes.map((b) => ({ id: b.id, name: b.name }));
