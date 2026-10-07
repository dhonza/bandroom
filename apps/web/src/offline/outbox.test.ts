// @vitest-environment node
import type { Marker } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { memoryOfflineDb } from "./db";
import {
  enqueueMixer,
  mergeMarkerEdit,
  replayOutbox,
  tempId,
  type OutboxPayloads,
  type OutboxSender,
} from "./outbox";

const marker = (over: Partial<Marker> = {}): Marker => ({
  id: "m1",
  songId: "s1",
  type: "section",
  name: "Verse",
  color: "blue",
  note: "",
  startSec: 10,
  endSec: 20,
  anchor: "time",
  startBeat: null,
  endBeat: null,
  lane: 0,
  createdBy: "u1",
  createdByName: "U",
  createdAt: 1,
  updatedAt: 100,
  ...over,
});

describe("mergeMarkerEdit (last write wins per field)", () => {
  const base = marker();
  it("keeps the offline change when the server did not touch the field", () => {
    const server = marker({ color: "red", updatedAt: 500 });
    expect(mergeMarkerEdit(base, server, { name: "Chorus" }, 300)).toEqual({ name: "Chorus" });
  });
  it("lets a newer server change of the same field win", () => {
    const server = marker({ name: "Bridge", updatedAt: 500 });
    expect(mergeMarkerEdit(base, server, { name: "Chorus", startSec: 12 }, 300)).toEqual({
      startSec: 12,
    });
  });
  it("wins over an older server change", () => {
    const server = marker({ name: "Bridge", updatedAt: 200 });
    expect(mergeMarkerEdit(base, server, { name: "Chorus" }, 300)).toEqual({ name: "Chorus" });
  });
  it("drops the edit when the marker was deleted on the server", () => {
    expect(mergeMarkerEdit(base, undefined, { name: "Chorus" }, 300)).toBeNull();
  });
});

class NetworkError extends Error {}

function sender(overrides: Partial<OutboxSender> = {}) {
  const calls: string[] = [];
  let n = 0;
  const s: OutboxSender = {
    createComment: (songId, body) => {
      calls.push(
        `comment ${songId} ${body.body} parent=${body.parentId ?? "-"} rid=${body.requestId ?? "-"}`,
      );
      return Promise.resolve({ id: `c${++n}` });
    },
    createMarker: (songId, body) => {
      calls.push(`marker+ ${songId} ${body.name}`);
      return Promise.resolve({ id: `m${++n}` });
    },
    listMarkers: () => Promise.resolve([marker()]),
    updateMarker: (id, patch) => {
      calls.push(`marker~ ${id} ${JSON.stringify(patch)}`);
      return Promise.resolve();
    },
    deleteMarker: (id) => {
      calls.push(`marker- ${id}`);
      return Promise.resolve();
    },
    putMixer: (songId) => {
      calls.push(`mixer ${songId}`);
      return Promise.resolve();
    },
    offlineEvent: (target, id, body) => {
      calls.push(`event ${target} ${id} ${body.action}`);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { s, calls };
}

const add = <K extends keyof OutboxPayloads>(
  db: ReturnType<typeof memoryOfflineDb>,
  kind: K,
  payload: OutboxPayloads[K],
  requestId = crypto.randomUUID(),
): Promise<number> => db.addOutbox({ requestId, kind, songId: "s1", createdAt: 1, payload });

describe("replayOutbox", () => {
  it("replays in order and maps ids made offline to the server's", async () => {
    const db = memoryOfflineDb();
    const rid = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01";
    await add(
      db,
      "comment.create",
      { tempId: tempId(rid), body: { body: "Top", requestId: rid } },
      rid,
    );
    await add(db, "comment.create", {
      tempId: "offline-x",
      body: { body: "Reply", parentId: tempId(rid) },
    });
    await add(db, "marker.create", {
      tempId: "offline-m",
      body: { type: "marker", name: "Hit", color: "red", startSec: 1 },
    });
    await add(db, "marker.delete", { markerId: "offline-m" });
    await add(db, "marker.update", {
      markerId: "m1",
      patch: { name: "Chorus" },
      base: marker(),
      editedAt: 300,
    });
    await add(db, "offline.event", {
      target: "song",
      id: "s1",
      body: { action: "removed", bytes: 0, quality: "normal" },
    });
    const { s, calls } = sender();
    const r = await replayOutbox({ db, send: s, isNetworkError: (e) => e instanceof NetworkError });
    expect(r).toEqual({ sent: 6, dropped: [], stopped: false });
    expect(calls).toEqual([
      `comment s1 Top parent=- rid=${rid}`,
      "comment s1 Reply parent=c1 rid=-",
      "marker+ s1 Hit",
      "marker- m3",
      'marker~ m1 {"name":"Chorus"}',
      "event song s1 removed",
    ]);
    expect(await db.outbox()).toEqual([]);
  });

  it("stops at a network failure and keeps the rest (with rewritten ids) for later", async () => {
    const db = memoryOfflineDb();
    await add(db, "comment.create", { tempId: "offline-a", body: { body: "A" } });
    await add(db, "comment.create", {
      tempId: "offline-b",
      body: { body: "B", parentId: "offline-a" },
    });
    let fail = false;
    const { s, calls } = sender();
    const flaky: OutboxSender = {
      ...s,
      createComment: (songId, body) => {
        if (fail) return Promise.reject(new NetworkError());
        fail = true;
        return s.createComment(songId, body);
      },
    };
    const r = await replayOutbox({
      db,
      send: flaky,
      isNetworkError: (e) => e instanceof NetworkError,
    });
    expect(r).toEqual({ sent: 1, dropped: [], stopped: true });
    const left = await db.outbox();
    expect(left).toHaveLength(1);
    expect((left[0]?.payload as OutboxPayloads["comment.create"]).body.parentId).toBe("c1");
    expect(calls).toHaveLength(1);
  });

  it("drops what the server rejects and edits of markers deleted there", async () => {
    const db = memoryOfflineDb();
    await add(db, "marker.update", {
      markerId: "gone",
      patch: { name: "X" },
      base: marker({ id: "gone" }),
      editedAt: 300,
    });
    await add(db, "comment.create", { tempId: "offline-c", body: { body: "Nope" } });
    await add(db, "mixer.put", { state: { tracks: {} } });
    const { s, calls } = sender({
      createComment: () => Promise.reject(new Error("FORBIDDEN")),
    });
    const r = await replayOutbox({ db, send: s, isNetworkError: () => false });
    expect(r.sent).toBe(1);
    expect(r.dropped.map((d) => d.kind)).toEqual(["marker.update", "comment.create"]);
    expect(calls).toEqual(["mixer s1"]);
    expect(await db.outbox()).toEqual([]);
  });

  it("marks changes refused because the song is locked (SPEC §25.12)", async () => {
    const db = memoryOfflineDb();
    await add(db, "marker.create", {
      tempId: "offline-m",
      body: { type: "marker", name: "A", color: "red", startSec: 1 },
    });
    await add(db, "comment.create", { tempId: "offline-c", body: { body: "Hi" } });
    class Locked extends Error {}
    const { s } = sender({
      createMarker: () => Promise.reject(new Locked("SONG_LOCKED")),
      createComment: () => Promise.reject(new Error("FORBIDDEN")),
    });
    const r = await replayOutbox({
      db,
      send: s,
      isNetworkError: () => false,
      isSongLocked: (e) => e instanceof Locked,
    });
    expect(r.dropped).toEqual([
      { kind: "marker.create", songId: "s1", locked: true },
      { kind: "comment.create", songId: "s1" },
    ]);
    expect(await db.outbox()).toEqual([]);
  });
});

describe("enqueueMixer", () => {
  it("keeps only the latest state per song", async () => {
    const db = memoryOfflineDb();
    await enqueueMixer(db, "s1", { tracks: {} }, "r1", 1);
    await enqueueMixer(db, "s2", { tracks: {} }, "r2", 2);
    await enqueueMixer(
      db,
      "s1",
      { tracks: { t: { gainDb: -3, pan: 0, mute: false, solo: false, listenedVersionId: null } } },
      "r3",
      3,
    );
    const list = await db.outbox();
    expect(list.map((e) => [e.songId, e.requestId])).toEqual([
      ["s2", "r2"],
      ["s1", "r3"],
    ]);
  });
});
