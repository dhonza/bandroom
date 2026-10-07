// @vitest-environment node
import type { Comment, Marker } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import type { OutboxEntry } from "./db";
import { pendingMixer, withPendingComments, withPendingMarkers } from "./pending";

const comment = (id: string, parentId: string | null = null): Comment => ({
  id,
  songId: "s1",
  trackId: null,
  parentId,
  author: { userId: "u1", name: "U", username: "u", kind: "user" },
  body: id,
  startSec: 1,
  endSec: null,
  context: { trackVersions: {}, tempoRev: null },
  source: "app",
  resolvedAt: null,
  resolvedByName: null,
  createdAt: 1,
  editedAt: null,
  deleted: false,
  reactions: [],
  mentions: [],
  replies: [],
});
const marker = (id: string, over: Partial<Marker> = {}): Marker => ({
  id,
  songId: "s1",
  type: "section",
  name: id,
  color: "blue",
  note: "",
  startSec: 1,
  endSec: 2,
  anchor: "time",
  startBeat: null,
  endBeat: null,
  lane: 0,
  createdBy: "u1",
  createdByName: "U",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
let seq = 0;
const entry = (kind: OutboxEntry["kind"], payload: unknown, songId = "s1"): OutboxEntry => ({
  seq: ++seq,
  requestId: `r${seq}`,
  kind,
  songId,
  createdAt: 1,
  payload,
});

describe("pending offline changes", () => {
  it("adds offline comments and replies to the list once", () => {
    const outbox = [
      entry("comment.create", { tempId: "offline-1", body: {}, preview: comment("offline-1") }),
      entry("comment.create", {
        tempId: "offline-2",
        body: {},
        preview: comment("offline-2", "c1"),
      }),
      entry(
        "comment.create",
        { tempId: "offline-3", body: {}, preview: comment("offline-3") },
        "s2",
      ),
    ];
    const list = withPendingComments([comment("c1")], outbox, "s1");
    expect(list.map((c) => c.id)).toEqual(["c1", "offline-1"]);
    expect(list[0]?.replies.map((r) => r.id)).toEqual(["offline-2"]);
    expect(withPendingComments(list, outbox, "s1")).toEqual(list);
  });

  it("applies offline marker creates, edits and deletes", () => {
    const outbox = [
      entry("marker.create", { tempId: "offline-m", body: {}, preview: marker("offline-m") }),
      entry("marker.update", {
        markerId: "a",
        patch: { name: "Chorus", startSec: 5 },
        base: marker("a"),
        editedAt: 2,
      }),
      entry("marker.delete", { markerId: "b" }),
    ];
    const list = withPendingMarkers([marker("a"), marker("b")], outbox, "s1");
    expect(list.map((m) => [m.id, m.name, m.startSec])).toEqual([
      ["a", "Chorus", 5],
      ["offline-m", "offline-m", 1],
    ]);
  });

  it("returns the latest offline mixer state of a song", () => {
    const outbox = [
      entry("mixer.put", { state: { tracks: {} } }),
      entry("mixer.put", {
        state: {
          tracks: { t: { gainDb: -6, pan: 0, mute: true, solo: false, listenedVersionId: null } },
        },
      }),
    ];
    expect(pendingMixer(outbox, "s1")?.tracks.t?.mute).toBe(true);
    expect(pendingMixer(outbox, "s2")).toBeNull();
  });
});
