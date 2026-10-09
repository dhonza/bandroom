import { describe, expect, it } from "vitest";
import {
  append,
  clearQueue,
  currentEntry,
  dropGone,
  endedIndex,
  entriesOf,
  focusSong,
  insertNext,
  moveEntry,
  nextReadyIndex,
  nextRepeat,
  queueOf,
  reconcile,
  removeEntry,
  startIndex,
  stepIndex,
  waitingAfter,
  withFreshReady,
  type PlayQueue,
  type QueueEntry,
  type QueueSource,
} from "./queue";

const e = (songId: string, ready = true, projectId = "p"): QueueEntry => ({
  songId,
  title: songId.toUpperCase(),
  subtitle: "",
  ready,
  projectId,
  projectName: projectId.toUpperCase(),
  imageHash: null,
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
    const fresh = withFreshReady([e("a"), e("b", false), e("c"), e("x", true, "p2")], "p", [
      e("a"),
      e("b"),
    ]);
    expect(fresh.map((x) => x.ready)).toEqual([true, true, false, true]);
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

  it("moves a mixed queue to it too", () => {
    const next = focusSong(q([e("a"), e("z", true, "p2")]), e("z", true, "p2"), source);
    expect(next.index).toBe(1);
    expect(next.entries).toHaveLength(2);
  });

  it("becomes a queue of its own otherwise", () => {
    for (const before of [null, q([e("x")])]) {
      const next = focusSong(before, e("a"), source);
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
    // In a mixed queue a deleted project takes only its own songs.
    const mixed = dropGone(q([e("a"), e("z", true, "p2")]), { projectId: "p2" });
    expect(mixed.result).toBe("removed");
    expect(mixed.queue?.entries.map((x) => x.songId)).toEqual(["a"]);
  });

  it("leaves an unrelated queue alone", () => {
    const before = q([e("a")]);
    expect(dropGone(before, { songIds: ["z"] })).toEqual({ result: "none", queue: before });
    expect(dropGone(before, { projectId: "other" }).result).toBe("none");
    expect(dropGone(null, { songIds: ["a"] }).result).toBe("none");
  });
});

describe("repeat (off → all → one)", () => {
  const entries = [e("a"), e("b", false), e("c")];

  it("cycles through the modes", () => {
    expect(nextRepeat("off")).toBe("all");
    expect(nextRepeat("all")).toBe("one");
    expect(nextRepeat("one")).toBe("off");
  });

  it("next/previous stop at the ends with repeat off and wrap otherwise", () => {
    expect(stepIndex(q(entries, 2), 1, "off")).toBeNull();
    expect(stepIndex(q(entries, 2), 1, "all")).toBe(0);
    expect(stepIndex(q(entries, 2), 1, "one")).toBe(0);
    expect(stepIndex(q(entries, 0), -1, "off")).toBeNull();
    expect(stepIndex(q(entries, 0), -1, "all")).toBe(2);
    expect(stepIndex(q(entries, 0), 1, "off")).toBe(2);
    // One song: repeat all comes back to it.
    expect(stepIndex(q([e("a")]), 1, "all")).toBe(0);
    expect(stepIndex(q([e("a", false)]), 1, "all")).toBeNull();
  });

  it("at a song's end: repeat one restarts it, all wraps, off stops", () => {
    expect(endedIndex(q(entries, 0), "one")).toBe(0);
    expect(endedIndex(q(entries, 0), "off")).toBe(2);
    expect(endedIndex(q(entries, 2), "off")).toBeNull();
    expect(endedIndex(q(entries, 2), "all")).toBe(0);
    expect(endedIndex(q(entries, 2), "one")).toBe(2);
  });
});

describe("editing the queue", () => {
  const ids = (x: PlayQueue) => x.entries.map((y) => y.songId);

  it("builds entries of a project's songs", () => {
    const [a] = entriesOf([{ songId: "a", title: "A", subtitle: "s", ready: true }], {
      projectId: "p9",
      projectName: "Nine",
      imageHash: "h",
    });
    expect(a).toEqual({
      songId: "a",
      title: "A",
      subtitle: "s",
      ready: true,
      projectId: "p9",
      projectName: "Nine",
      imageHash: "h",
    });
  });

  it("moves an entry; the index follows the playing song", () => {
    const before = q([e("a"), e("b"), e("c")], 1);
    const moved = moveEntry(before, 2, 0);
    expect(ids(moved)).toEqual(["c", "a", "b"]);
    expect(moved.index).toBe(2);
    const cur = moveEntry(before, 1, 2);
    expect(ids(cur)).toEqual(["a", "c", "b"]);
    expect(cur.index).toBe(2);
    expect(moveEntry(before, 0, 5)).toBe(before);
    expect(moveEntry(before, 7, 0)).toBe(before);
    expect(moveEntry(before, 1, 1)).toBe(before);
  });

  it("removes an entry but not the playing song", () => {
    const before = q([e("a"), e("b"), e("c")], 1);
    const r = removeEntry(before, 0);
    expect(ids(r)).toEqual(["b", "c"]);
    expect(r.index).toBe(0);
    expect(ids(removeEntry(before, 2))).toEqual(["a", "b"]);
    expect(removeEntry(before, 1)).toBe(before);
    expect(removeEntry(before, 9)).toBe(before);
  });

  it("plays songs next, moving queued ones; another project makes the queue mixed", () => {
    const before = q([e("a"), e("b"), e("c")], 0);
    const n = insertNext(before, [e("c"), e("x", true, "p2")]);
    expect(ids(n)).toEqual(["a", "c", "x", "b"]);
    expect(n.index).toBe(0);
    expect(n.source.kind).toBe("mixed");
    expect(n.source.projectId).toBe("p");
    // The playing song is not moved.
    const same = insertNext(q([e("a"), e("b")], 1), [e("b")]);
    expect(ids(same)).toEqual(["a", "b"]);
    expect(same.index).toBe(1);
    expect(insertNext(before, [e("d")]).source.kind).toBe("project");
  });

  it("adds songs at the end, moving queued ones", () => {
    const before = q([e("a"), e("b"), e("c")], 1);
    const r = append(before, [e("a"), e("d")]);
    expect(ids(r)).toEqual(["b", "c", "a", "d"]);
    expect(r.index).toBe(0);
    expect(append(before, [e("b")]).entries).toHaveLength(3);
  });

  it("clears all but the playing song", () => {
    const r = clearQueue({
      ...q([e("a"), e("z", true, "p2")], 1),
      source: { ...source, kind: "mixed" },
    });
    expect(ids(r)).toEqual(["z"]);
    expect(r.index).toBe(0);
    expect(r.source).toEqual({ kind: "song", projectId: "p2", projectName: "P2", imageHash: null });
    const empty: PlayQueue = { entries: [], index: 0, source };
    expect(clearQueue(empty)).toBe(empty);
  });

  it("starts a queue of added songs when nothing was queued", () => {
    expect(queueOf([])).toBeNull();
    const r = queueOf([e("a"), e("z", true, "p2")]);
    expect(r?.index).toBe(0);
    expect(r?.source.kind).toBe("mixed");
    expect(queueOf([e("a")])?.source.kind).toBe("project");
  });
});

describe("a saved queue checked against the server", () => {
  const saved = q([e("a"), e("b"), e("c"), e("x", true, "p2")], 1);
  const item = (songId: string, ready = true) => ({
    songId,
    title: `${songId}!`,
    subtitle: "",
    ready,
  });

  it("drops songs no longer there and takes fresh titles and ready flags", () => {
    const r = reconcile(saved, new Map([["p", [item("a", false), item("b")]]]));
    expect(r?.entries.map((x) => [x.songId, x.title, x.ready])).toEqual([
      ["a", "a!", false],
      ["b", "b!", true],
      ["x", "X", true],
    ]);
    expect(r?.index).toBe(1);
  });

  it("moves on when the current song is gone, and drops unreadable projects", () => {
    const r = reconcile(
      saved,
      new Map<string, ReturnType<typeof item>[] | "gone">([["p", [item("a"), item("c")]]]),
    );
    expect(r?.entries.map((x) => x.songId)).toEqual(["a", "c", "x"]);
    expect(r?.index).toBe(1);
    const last = reconcile(q([e("a"), e("b")], 1), new Map([["p", [item("a")]]]));
    expect(last?.index).toBe(0);
    expect(
      reconcile(
        saved,
        new Map([
          ["p", "gone" as const],
          ["p2", "gone" as const],
        ]),
      ),
    ).toBeNull();
  });
});
