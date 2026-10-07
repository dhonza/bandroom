import { describe, expect, it } from "vitest";
import {
  currentEntry,
  dropGone,
  focusSong,
  nextReadyIndex,
  startIndex,
  waitingAfter,
  withFreshReady,
  type PlayQueue,
  type QueueEntry,
  type QueueSource,
} from "./queue";

const e = (songId: string, ready = true): QueueEntry => ({
  songId,
  title: songId.toUpperCase(),
  subtitle: "",
  ready,
});
const source: QueueSource = { kind: "project", projectId: "p", projectName: "P", imageHash: null };
const q = (entries: QueueEntry[], index = 0): PlayQueue => ({ entries, index, source });

describe("queue advance (SPEC §6.10)", () => {
  const entries = [e("a"), e("b", false), e("c"), e("d", false)];

  it("skips songs without audio in both directions and stops at the ends", () => {
    expect(nextReadyIndex(entries, 0, 1)).toBe(2);
    expect(nextReadyIndex(entries, 2, 1)).toBeNull();
    expect(nextReadyIndex(entries, 2, -1)).toBe(0);
    expect(nextReadyIndex(entries, 0, -1)).toBeNull();
    expect(nextReadyIndex([], 0, 1)).toBeNull();
  });

  it("starts at the asked song, or the next ready one after it", () => {
    expect(startIndex(entries)).toBe(0);
    expect(startIndex(entries, "c")).toBe(2);
    expect(startIndex(entries, "b")).toBe(2);
    expect(startIndex(entries, "d")).toBeNull();
    expect(startIndex(entries, "unknown")).toBe(0);
    expect(startIndex([e("x", false)])).toBeNull();
  });

  it("reads the current entry", () => {
    expect(currentEntry(q(entries, 2))?.songId).toBe("c");
    expect(currentEntry(null)).toBeNull();
  });
});

describe("songs that finish processing while the queue plays", () => {
  it("knows when songs after the current one were not ready", () => {
    expect(waitingAfter(q([e("a"), e("b", false)]))).toBe(true);
    expect(waitingAfter(q([e("a", false), e("b")], 1))).toBe(false);
  });

  it("takes the fresh ready flags; songs gone from the project cannot play", () => {
    const fresh = withFreshReady([e("a"), e("b", false), e("c")], [e("a"), e("b")]);
    expect(fresh.map((x) => x.ready)).toEqual([true, true, false]);
    expect(fresh[1]?.title).toBe("B");
  });
});

describe("a song opened on its page", () => {
  it("moves a queue of its project to it", () => {
    const next = focusSong(q([e("a"), e("b", false), e("c")]), e("b"), {
      ...source,
      kind: "song",
    });
    expect(next.index).toBe(1);
    expect(next.entries).toHaveLength(3);
    expect(next.entries[1]?.ready).toBe(true);
    expect(next.source.kind).toBe("project");
  });

  it("becomes a queue of its own otherwise", () => {
    const other = { ...source, projectId: "p2" };
    for (const before of [null, q([e("a")]), q([e("x")])]) {
      const next = focusSong(before, e("a"), before?.entries[0]?.songId === "x" ? source : other);
      expect(next.entries.map((x) => x.songId)).toEqual(["a"]);
      expect(next.index).toBe(0);
      expect(next.source.kind).toBe("song");
    }
  });
});

describe("deleted songs leave the queue", () => {
  it("drops other songs and follows the playing one", () => {
    const r = dropGone(q([e("a"), e("b"), e("c")], 2), { songIds: ["a"] });
    expect(r.result).toBe("removed");
    expect(r.queue?.entries.map((x) => x.songId)).toEqual(["b", "c"]);
    expect(r.queue?.index).toBe(1);
  });

  it("stops when the playing song or its project is gone", () => {
    expect(dropGone(q([e("a"), e("b")], 1), { songIds: ["b"] })).toEqual({
      result: "stopped",
      queue: null,
    });
    expect(dropGone(q([e("a")]), { projectId: "p" }).result).toBe("stopped");
  });

  it("leaves an unrelated queue alone", () => {
    const before = q([e("a")]);
    expect(dropGone(before, { songIds: ["z"] })).toEqual({ result: "none", queue: before });
    expect(dropGone(before, { projectId: "other" }).result).toBe("none");
    expect(dropGone(null, { songIds: ["a"] }).result).toBe("none");
  });
});
