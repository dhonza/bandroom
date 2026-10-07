import type { ListenSource, Song } from "@bandroom/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useListen, type QueueEntry } from "../../player/listenStore";

const listenEngine = vi.hoisted(() => ({
  currentTime: vi.fn(() => 42),
  pause: vi.fn(),
  playQueue: vi.fn(),
  seek: vi.fn(),
}));
const controller = vi.hoisted(() => ({
  prepareEngine: vi.fn(),
  releasePlayback: vi.fn(() => ({ atSec: 30, playing: true })),
  setPendingStart: vi.fn(),
}));
vi.mock("../../player/listenEngine", () => listenEngine);
vi.mock("../../rehearse/controller", () => controller);

const { closeMixer, openMixer, songQueue } = await import("./playerHandoff");

const src = (hash: string): ListenSource => ({
  trackVersionId: `v-${hash}`,
  isAutoMix: true,
  status: "ready",
  durationSec: 100,
  opus: { hash: hash.repeat(64).slice(0, 64), bitrate: 128 },
  opusLow: null,
  peaks: null,
});

const entry = (id: string): QueueEntry => ({
  songId: id,
  title: `Song ${id}`,
  subtitle: "",
  projectId: "p",
  projectName: "Album",
  imageHash: null,
  listen: src(id),
});

const song: Pick<Song, "id" | "title" | "subtitle" | "project"> = {
  id: "b",
  title: "Song b",
  subtitle: "",
  project: { id: "p", name: "Album", color: "teal", imageHash: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  useListen.setState({ queue: [], index: 0, status: "idle", position: 0, duration: 0 });
});

describe("songQueue", () => {
  it("uses the project queue with the fresh source of this song", () => {
    const fresh = src("x");
    const { items, index } = songQueue(song, fresh, [entry("a"), entry("b"), entry("c")]);
    expect(index).toBe(1);
    expect(items.map((q) => q.songId)).toEqual(["a", "b", "c"]);
    expect(items[1]?.listen).toBe(fresh);
  });

  it("plays the song on its own without the queue", () => {
    const { items, index } = songQueue(song, src("b"), undefined);
    expect(index).toBe(0);
    expect(items).toHaveLength(1);
    expect(items[0]?.projectName).toBe("Album");
  });
});

describe("openMixer", () => {
  it("hands the playing mix over at its position", () => {
    useListen.setState({ queue: [entry("a"), entry("b")], index: 1, status: "playing" });
    openMixer("b");
    expect(listenEngine.pause).toHaveBeenCalled();
    expect(controller.prepareEngine).toHaveBeenCalled();
    expect(controller.setPendingStart).toHaveBeenCalledWith("b", 42, true);
  });

  it("keeps a paused mix paused", () => {
    useListen.setState({ queue: [entry("b")], index: 0, status: "paused" });
    openMixer("b");
    expect(controller.setPendingStart).toHaveBeenCalledWith("b", 42, false);
  });

  it("leaves another song alone", () => {
    useListen.setState({ queue: [entry("a")], index: 0, status: "playing" });
    openMixer("b");
    expect(listenEngine.pause).not.toHaveBeenCalled();
    expect(controller.prepareEngine).toHaveBeenCalled();
    expect(controller.setPendingStart).not.toHaveBeenCalled();
  });
});

describe("closeMixer", () => {
  it("starts the mix where the engine was playing", () => {
    closeMixer(song, src("b"), [entry("a"), entry("b")]);
    expect(controller.releasePlayback).toHaveBeenCalledWith("b");
    expect(listenEngine.playQueue).toHaveBeenCalledWith(expect.any(Array), 1, {
      startAt: 30,
      autoplay: true,
    });
  });

  it("seeks the paused mix of this song", () => {
    controller.releasePlayback.mockReturnValueOnce({ atSec: 12, playing: false });
    useListen.setState({ queue: [entry("b")], index: 0, status: "paused" });
    closeMixer(song, src("b"), undefined);
    expect(listenEngine.seek).toHaveBeenCalledWith(12);
    expect(listenEngine.playQueue).not.toHaveBeenCalled();
  });

  it("cues the song paused, but never stops another song that plays", () => {
    controller.releasePlayback.mockReturnValue({ atSec: 12, playing: false });
    closeMixer(song, src("b"), undefined);
    expect(listenEngine.playQueue).toHaveBeenCalledWith(expect.any(Array), 0, {
      startAt: 12,
      autoplay: false,
    });
    listenEngine.playQueue.mockClear();
    useListen.setState({ queue: [entry("a")], index: 0, status: "playing" });
    closeMixer(song, src("b"), undefined);
    expect(listenEngine.playQueue).not.toHaveBeenCalled();
    controller.releasePlayback.mockReset();
  });

  it("plays when asked (lock hint), even from a paused engine", () => {
    controller.releasePlayback.mockReturnValueOnce({ atSec: 5, playing: false });
    closeMixer(song, src("b"), undefined, { play: true });
    expect(listenEngine.playQueue).toHaveBeenCalledWith(expect.any(Array), 0, {
      startAt: 5,
      autoplay: true,
    });
  });
});
