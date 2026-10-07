import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dropFromQueue,
  next,
  playQueue,
  previous,
  resetListenEngineForTests,
  seek,
  setListenLoop,
  setQuality,
  setRepeat,
  stop,
  togglePlay,
} from "./listenEngine";
import { nextPlayableIndex, useListen, type ListenSource, type QueueEntry } from "./listenStore";

const src = (hash: string, status: ListenSource["status"] = "ready"): ListenSource => ({
  trackVersionId: `v-${hash}`,
  isAutoMix: true,
  status,
  durationSec: 100,
  opus: { hash: hash.repeat(64).slice(0, 64), bitrate: 128 },
  opusLow: { hash: `${hash}l`.repeat(32).slice(0, 64), bitrate: 48 },
  peaks: null,
});

const entry = (id: string, listen: ListenSource | null = src(id)): QueueEntry => ({
  songId: id,
  title: `Song ${id}`,
  subtitle: "",
  projectId: "p",
  projectName: "Album",
  imageHash: null,
  listen,
});

let play: ReturnType<typeof vi.fn>;
beforeEach(() => {
  play = vi.fn(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play as () => Promise<void>);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  resetListenEngineForTests();
  useListen.setState({
    queue: [],
    index: 0,
    status: "idle",
    position: 0,
    duration: 0,
    repeat: "off",
    quality: "high",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("nextPlayableIndex", () => {
  const q = [entry("a"), entry("b", null), entry("c", src("c", "processing")), entry("d")];
  it("skips songs without ready audio and wraps only with repeat-all", () => {
    expect(nextPlayableIndex(q, 0, 1, false)).toBe(3);
    expect(nextPlayableIndex(q, 3, 1, false)).toBeNull();
    expect(nextPlayableIndex(q, 3, 1, true)).toBe(0);
    expect(nextPlayableIndex(q, 3, -1, false)).toBe(0);
  });
});

describe("listen engine", () => {
  it("plays a queue from a playable song and exposes metadata", () => {
    playQueue([entry("a", null), entry("b"), entry("c")], 0);
    const s = useListen.getState();
    expect(s.index).toBe(1);
    expect(s.status).toBe("loading");
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("advances on next, restarts or goes back on previous", () => {
    playQueue([entry("a"), entry("b")], 0);
    next();
    expect(useListen.getState().index).toBe(1);
    previous(); // near the start → previous song
    expect(useListen.getState().index).toBe(0);
    next();
    seek(50);
    previous(); // > 3 s in → restart the same song
    expect(useListen.getState().index).toBe(1);
    expect(useListen.getState().position).toBe(0);
  });

  it("repeat-all wraps at the end of the queue", () => {
    playQueue([entry("a"), entry("b")], 1);
    next();
    expect(useListen.getState().index).toBe(1); // no wrap
    setRepeat("all");
    next();
    expect(useListen.getState().index).toBe(0);
  });

  it("switches quality and stops cleanly", () => {
    playQueue([entry("a")], 0);
    setQuality("low");
    expect(useListen.getState().quality).toBe("low");
    togglePlay();
    stop();
    expect(useListen.getState()).toMatchObject({ queue: [], status: "idle" });
  });
});

describe("listen engine timing", () => {
  let el: HTMLMediaElement | null;
  let ready: number;
  let paused: boolean;
  let times: number[];
  beforeEach(() => {
    el = null;
    ready = 0;
    paused = true;
    times = [];
    const els: HTMLMediaElement[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      els.push(this);
      el = els[0] ?? null;
      paused = false;
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(() => ready);
    vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(() => paused);
    vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation((t: number) => {
      times.push(t);
    });
  });

  it("applies a start position once the metadata is there", () => {
    playQueue([entry("a")], 0, { startAt: 30 });
    expect(times).toEqual([]); // before metadata (Safari would ignore it)
    seek(42); // a later seek replaces it
    expect(useListen.getState().position).toBe(42);
    el?.dispatchEvent(new Event("loadedmetadata"));
    expect(times).toEqual([42]);
    ready = HTMLMediaElement.HAVE_METADATA;
    seek(10);
    expect(times).toEqual([42, 10]);
  });

  it("runs the loop check only while playing", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    try {
      playQueue([entry("a")], 0);
      paused = true; // paused before a loop is set
      setListenLoop("a", { start: 1, end: 2 });
      expect(frames).toHaveLength(0);
      togglePlay(); // the play event starts the checks
      expect(frames).toHaveLength(1);
      frames.shift()?.(0);
      expect(frames).toHaveLength(1);
      paused = true;
      frames.shift()?.(0); // stops after a pause
      expect(frames).toHaveLength(0);
    } finally {
      setListenLoop("a", null);
      vi.unstubAllGlobals();
    }
  });
});

describe("dropFromQueue (deleted songs, SPEC §6.10)", () => {
  const other = (id: string, projectId: string): QueueEntry => ({ ...entry(id), projectId });

  it("stops when the playing song is deleted", () => {
    playQueue([entry("a"), entry("b")], 1);
    expect(dropFromQueue({ songIds: ["b"] })).toBe("stopped");
    expect(useListen.getState()).toMatchObject({ queue: [], status: "idle" });
  });

  it("removes other deleted songs and keeps the current one playing", () => {
    playQueue([entry("a"), entry("b"), entry("c")], 2);
    expect(dropFromQueue({ songIds: ["a"] })).toBe("removed");
    const s = useListen.getState();
    expect(s.queue.map((e) => e.songId)).toEqual(["b", "c"]);
    expect(s.index).toBe(1);
    expect(s.queue[s.index]?.songId).toBe("c");
  });

  it("drops a deleted project's songs", () => {
    playQueue([other("a", "p1"), other("b", "p2"), other("c", "p1")], 1);
    expect(dropFromQueue({ projectId: "p1" })).toBe("removed");
    expect(useListen.getState().queue.map((e) => e.songId)).toEqual(["b"]);
    expect(useListen.getState().index).toBe(0);
    expect(dropFromQueue({ projectId: "p2" })).toBe("stopped");
  });

  it("does nothing for songs not in the queue", () => {
    playQueue([entry("a")], 0);
    expect(dropFromQueue({ songIds: ["x"] })).toBe("none");
    expect(dropFromQueue({})).toBe("none");
    expect(useListen.getState().queue).toHaveLength(1);
  });
});
