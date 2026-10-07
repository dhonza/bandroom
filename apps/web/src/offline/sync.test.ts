// @vitest-environment node
import type { OfflineProjectManifest, OfflineSongManifest } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { itemKey, memoryOfflineDb, type OfflineItem } from "./db";
import {
  checkItem,
  memoryCache,
  missingBytes,
  planProject,
  planSong,
  removeItem,
  syncItem,
  type SyncDeps,
  type UrlScheme,
} from "./sync";

const O = "https://band.test";
const urls: UrlScheme = {
  blob: (h) => `${O}/api/v1/blobs/${h}`,
  global: () => [`${O}/api/v1/auth/session`],
  project: (p) => [`${O}/api/v1/projects/${p}`],
  song: (s) => [
    `${O}/api/v1/songs/${s.songId}`,
    ...s.trackIds.map((t) => `${O}/api/v1/tracks/${t}/versions`),
  ],
  document: (d) => [
    `${O}/api/v1/documents/${d.documentId}`,
    `${O}/api/v1/document-versions/${d.versionId}/content`,
  ],
  commentsPage: (s, c) => `${O}/api/v1/songs/${s}/comments${c ? `?cursor=${c}` : ""}`,
};

const song = (
  id: string,
  blobs: [string, number][],
  extra: Partial<OfflineSongManifest> = {},
): OfflineSongManifest => ({
  songId: id,
  projectId: "p1",
  title: `Song ${id}`,
  trackIds: [`t-${id}`],
  blobs: blobs.map(([hash, bytes]) => ({ hash, bytes })),
  documents: [],
  ...extra,
});

function setup(manifests: {
  songs: Record<string, OfflineSongManifest>;
  project?: OfflineProjectManifest;
}) {
  const db = memoryOfflineDb();
  const blobs = memoryCache();
  const pinned = memoryCache();
  const fetched: string[] = [];
  const gone: string[] = [];
  let offline = false;
  const deps: SyncDeps = {
    db,
    blobs,
    pinned,
    urls,
    fetch: (url) => {
      if (offline) return Promise.reject(new TypeError("Failed to fetch"));
      fetched.push(url);
      if (url.includes("/comments")) {
        const next = url.includes("cursor") ? null : "c2";
        return Promise.resolve(Response.json({ comments: [], nextCursor: next }));
      }
      if (url.includes("/blobs/")) return Promise.resolve(new Response(`bytes of ${url}`));
      return Promise.resolve(Response.json({ url }));
    },
    songManifest: (item) => {
      const m = manifests.songs[item.id];
      return m ? Promise.resolve(m) : Promise.reject(new Error("no manifest"));
    },
    projectManifest: () =>
      manifests.project ? Promise.resolve(manifests.project) : Promise.reject(new Error("none")),
    now: () => 1000,
    isGone: (err) => err instanceof Error && err.message === "gone",
    onGone: (item) => gone.push(item.key),
  };
  return {
    deps,
    db,
    blobs,
    pinned,
    fetched,
    gone,
    goOffline: () => {
      offline = true;
    },
  };
}

const newItem = (kind: "song" | "project", id: string): OfflineItem => ({
  key: itemKey(kind, id),
  kind,
  id,
  title: "",
  projectId: "p1",
  addedAt: 1,
  syncedAt: null,
  autoUpdate: true,
  quality: "normal",
  lossless: false,
  status: "downloading",
  error: null,
  bytes: 0,
  blobs: [],
  urls: [],
  songIds: [],
});

describe("offline plans", () => {
  it("collects a song's files, API responses and sizes", () => {
    const plan = planSong(
      song(
        "s1",
        [
          ["a", 10],
          ["b", 5],
          ["a", 10],
        ],
        {
          documents: [{ documentId: "d1", versionId: "v1", bytes: 7 }],
        },
      ),
      urls,
    );
    expect(plan.blobs.map((b) => b.hash)).toEqual(["a", "b"]);
    expect(plan.bytes).toBe(22);
    expect(plan.urls).toEqual([
      `${O}/api/v1/auth/session`,
      `${O}/api/v1/projects/p1`,
      `${O}/api/v1/songs/s1`,
      `${O}/api/v1/tracks/t-s1/versions`,
      `${O}/api/v1/documents/d1`,
      `${O}/api/v1/document-versions/v1/content`,
    ]);
  });

  it("merges a project's songs and shares files between them", () => {
    const plan = planProject(
      {
        projectId: "p1",
        name: "Album",
        blobs: [{ hash: "img", bytes: 3 }],
        documents: [],
        songs: [
          song("s1", [["a", 10]]),
          song("s2", [
            ["a", 10],
            ["c", 1],
          ]),
        ],
      },
      urls,
    );
    expect(plan.blobs.map((b) => b.hash)).toEqual(["img", "a", "c"]);
    expect(plan.bytes).toBe(14);
    expect(plan.songIds).toEqual(["s1", "s2"]);
  });
});

describe("syncItem", () => {
  it("downloads blobs and pins responses incl. every comment page", async () => {
    const t = setup({
      songs: {
        s1: song("s1", [
          ["a", 10],
          ["b", 5],
        ]),
      },
    });
    await t.db.putItem(newItem("song", "s1"));
    const progress: number[] = [];
    t.deps.onProgress = (_k, done) => progress.push(done);
    const item = await syncItem(t.deps, "song:s1");
    expect(item).toMatchObject({ status: "ready", bytes: 15, blobs: ["a", "b"], syncedAt: 1000 });
    expect(item?.title).toBe("Song s1");
    expect(await t.blobs.keys()).toEqual([urls.blob("a"), urls.blob("b")]);
    expect(await t.pinned.keys()).toContain(urls.commentsPage("s1", "c2"));
    expect(item?.urls).toContain(urls.commentsPage("s1"));
    expect(progress.at(-1)).toBe(15);
  });

  it("reuses cached blobs, and drops files of old versions only after a refresh", async () => {
    const manifests = { songs: { s1: song("s1", [["a", 10]]) } };
    const t = setup(manifests);
    await t.db.putItem(newItem("song", "s1"));
    await syncItem(t.deps, "song:s1");
    // A new current version: "a" is replaced by "a2".
    manifests.songs.s1 = song("s1", [["a2", 12]]);
    expect(await missingBytes(t.deps, planSong(manifests.songs.s1, urls))).toBe(12);
    t.fetched.length = 0;
    const item = await syncItem(t.deps, "song:s1");
    expect(item?.blobs).toEqual(["a2"]);
    expect(t.fetched.filter((u) => u.includes("/blobs/"))).toEqual([urls.blob("a2")]);
    expect(await t.blobs.keys()).toEqual([urls.blob("a2")]);
  });

  it("keeps the previous copy and reports the error when the network fails", async () => {
    const manifests = { songs: { s1: song("s1", [["a", 10]]) } };
    const t = setup(manifests);
    await t.db.putItem(newItem("song", "s1"));
    await syncItem(t.deps, "song:s1");
    manifests.songs.s1 = song("s1", [["new", 1]]);
    t.goOffline();
    expect(await syncItem(t.deps, "song:s1")).toBeNull();
    const item = await t.db.getItem("song:s1");
    expect(item).toMatchObject({ status: "error", error: "NETWORK", blobs: ["a"] });
    expect(await t.blobs.keys()).toEqual([urls.blob("a")]);
  });

  it("keeps files shared with another item when one is removed", async () => {
    const t = setup({
      songs: {
        s1: song("s1", [
          ["a", 10],
          ["b", 1],
        ]),
        s2: song("s2", [["a", 10]]),
      },
    });
    await t.db.putItem(newItem("song", "s1"));
    await t.db.putItem(newItem("song", "s2"));
    await syncItem(t.deps, "song:s1");
    await syncItem(t.deps, "song:s2");
    await removeItem(t.deps, "song:s1");
    expect(await t.blobs.keys()).toEqual([urls.blob("a")]);
    expect(await t.pinned.keys()).not.toContain(`${O}/api/v1/songs/s1`);
    expect(await t.pinned.keys()).toContain(`${O}/api/v1/songs/s2`);
    await removeItem(t.deps, "song:s2");
    expect(await t.blobs.keys()).toEqual([]);
    expect(await t.pinned.keys()).toEqual([]);
  });

  it("with auto-update off, marks an item outdated when the server has new files", async () => {
    const manifests = { songs: { s1: song("s1", [["a", 10]]) } };
    const t = setup(manifests);
    await t.db.putItem({ ...newItem("song", "s1"), autoUpdate: false });
    await syncItem(t.deps, "song:s1");
    expect((await checkItem(t.deps, "song:s1"))?.status).toBe("ready");
    manifests.songs.s1 = song("s1", [
      ["a", 10],
      ["b", 2],
    ]);
    expect((await checkItem(t.deps, "song:s1"))?.status).toBe("outdated");
    expect(await t.blobs.keys()).toEqual([urls.blob("a")]);
  });

  it("removes the copy of a song deleted on the server, but not on network errors", async () => {
    const manifests: { songs: Record<string, OfflineSongManifest> } = {
      songs: { s1: song("s1", [["a", 10]]), s2: song("s2", [["b", 5]]) },
    };
    const t = setup(manifests);
    t.deps.songManifest = (item) =>
      item.id in manifests.songs
        ? Promise.resolve(manifests.songs[item.id] as OfflineSongManifest)
        : Promise.reject(new Error("gone"));
    await t.db.putItem(newItem("song", "s1"));
    await t.db.putItem({ ...newItem("song", "s2"), autoUpdate: false });
    await syncItem(t.deps, "song:s1");
    await syncItem(t.deps, "song:s2");
    delete manifests.songs.s1;
    delete manifests.songs.s2;
    // Auto-update on (sync) and off (check) both remove the copy and report it once.
    expect(await syncItem(t.deps, "song:s1")).toBeNull();
    expect(await checkItem(t.deps, "song:s2")).toBeNull();
    expect(await t.db.getItem("song:s1")).toBeUndefined();
    expect(await t.db.getItem("song:s2")).toBeUndefined();
    expect(t.gone).toEqual(["song:s1", "song:s2"]);
    expect(await t.blobs.keys()).toEqual([]);
  });

  it("keeps the copy when the manifest fails for another reason", async () => {
    const manifests = { songs: { s1: song("s1", [["a", 10]]) } };
    const t = setup(manifests);
    await t.db.putItem(newItem("song", "s1"));
    await syncItem(t.deps, "song:s1");
    t.deps.songManifest = () => Promise.reject(new Error("HTTP 500"));
    expect(await syncItem(t.deps, "song:s1")).toBeNull();
    expect(await t.db.getItem("song:s1")).toMatchObject({ status: "error", blobs: ["a"] });
    expect((await checkItem(t.deps, "song:s1"))?.key).toBe("song:s1");
    expect(t.gone).toEqual([]);
  });
});
