import type { Song, Track, TrackVersion } from "@bandroom/shared";
import type { QueueLoader } from "../player/queueLoader";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Rehearse controller against a fake engine (no Web Audio in jsdom): what it loads, when it
 * reloads, and how it reacts to engine states and errors.
 */

type Listener = (e: unknown) => void;

const fake = vi.hoisted(() => {
  class FakeEngine {
    static instance: FakeEngine | null = null;
    state = "idle";
    lengthFrames = 0;
    failInit = 0;
    loads: {
      tracks: { id: string; clips: { variant: { hash: string } }[]; trimDb?: number }[];
    }[] = [];
    switches: { trackId: string; hash: string; trimDb?: number | undefined }[] = [];
    trims: { trackId: string; trimDb: number }[] = [];
    plays = 0;
    inits = 0;
    suspended = 0;
    listeners = new Map<string, Set<Listener>>();
    constructor() {
      FakeEngine.instance = this;
    }
    on(event: string, cb: Listener) {
      let set = this.listeners.get(event);
      if (!set) {
        set = new Set();
        this.listeners.set(event, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    }
    emit(event: string, payload: unknown) {
      for (const cb of this.listeners.get(event) ?? []) cb(payload);
    }
    setState(s: string) {
      this.state = s;
      this.emit("state", s);
    }
    init() {
      this.inits++;
      if (this.failInit > 0) {
        this.failInit--;
        this.setState("error");
        return Promise.reject(new Error("no audio"));
      }
      return Promise.resolve();
    }
    async loadSong(song: FakeEngine["loads"][number] & { lengthFrames: number }) {
      await this.init();
      this.setState("loading");
      this.loads.push(song);
      this.lengthFrames = song.lengthFrames;
      this.setState("stopped");
      return true;
    }
    play() {
      this.plays++;
      this.setState("playing");
    }
    pause() {
      if (this.state === "playing" || this.state === "buffering") this.setState("stopped");
    }
    suspend() {
      this.suspended++;
      this.pause();
    }
    seeks: number[] = [];
    seek(frames: number) {
      this.seeks.push(frames);
    }
    loops: unknown[] = [];
    setLoop(range: unknown) {
      this.loops.push(range);
    }
    setClick() {}
    setClickTrack() {}
    setRepeatCountIn() {}
    gains: { trackId: string; gainDb: number }[] = [];
    setTrackState(trackId: string, s: { trimDb?: number; gainDb?: number }) {
      if (s.trimDb !== undefined) this.trims.push({ trackId, trimDb: s.trimDb });
      if (s.gainDb !== undefined) this.gains.push({ trackId, gainDb: s.gainDb });
    }
    switchSource(
      trackId: string,
      clips: { variant: { hash: string } }[],
      _offsetDb?: number,
      trimDb?: number,
    ) {
      this.switches.push({ trackId, hash: clips[0]?.variant.hash ?? "", trimDb });
    }
    getPositionFrames() {
      return 0;
    }
    getCountIn() {
      return null;
    }
  }
  return { FakeEngine };
});

vi.mock("@bandroom/audio-engine", () => ({
  Engine: fake.FakeEngine,
  SAMPLE_RATE: 48_000,
  setPlaybackAudioSession: () => undefined,
  WakeLockController: class {
    setPlaying() {}
    setSongOpen() {}
    setMode() {}
  },
  clickTrackFor: () => null,
  countInSpecAt: () => null,
}));
vi.mock("@bandroom/audio-engine/worker?worker&url", () => ({ default: "worker.js" }));
vi.mock("@bandroom/audio-engine/worklet?worker&url", () => ({ default: "worklet.js" }));
const apiMock = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
vi.mock("../api/client", () => ({ api: apiMock }));

const controller = await import("./controller");
const { openSong, retryAudio, togglePlay, useRehearse } = controller;

const engine = () => {
  const e = fake.FakeEngine.instance;
  if (!e) throw new Error("no engine");
  return e;
};

function version(id: string, hash: string): TrackVersion {
  return {
    id,
    number: 1,
    label: "",
    notes: "",
    offsetSamples: 0,
    gainDb: 0,
    source: "upload",
    createdAt: 0,
    uploadedBy: null,
    uploaderName: null,
    originalFilename: "a.wav",
    sizeBytes: 1,
    status: "ready",
    error: null,
    archived: null,
    progress: null,
    media: null,
    variants: {
      opus: { hash, bitrate: 96, channels: 2, preSkip: 312, durationSamples48k: 480_000 },
      opusLow: null,
      flac: null,
      peaks: null,
      seekIndex: { opus: null, opusLow: null, flac: null },
    },
    downloads: [],
  };
}

function track(id: string, current = version(`${id}-v1`, `${id}1`)): Track {
  return {
    id,
    songId: "s",
    name: id,
    color: "blue",
    sortOrder: 0,
    instrumentTag: "",
    defaultGainDb: 0,
    defaultPan: 0,
    defaultMuted: false,
    versionCount: 2,
    createdBy: null,
    current,
  };
}

const info = (songId: string) => ({
  songId,
  title: songId,
  subtitle: "",
  projectId: "p",
  projectName: "P",
  imageHash: null,
});

let song = 0;
/** A fresh song id per test: the controller's module state persists across tests. */
const nextSong = () => `song-${++song}`;

beforeEach(() => {
  // Each test starts with no song in the mini-player (a paused one would keep the engine).
  controller.stopPlayer();
  useRehearse.setState({ previewSongId: null });
  const e = fake.FakeEngine.instance;
  if (e) {
    e.loads = [];
    e.switches = [];
    e.trims = [];
    e.gains = [];
    e.seeks = [];
    e.loops = [];
    e.plays = 0;
    e.inits = 0;
    e.suspended = 0;
    e.failInit = 0;
    e.state = "stopped";
  }
});

describe("engine start failure", () => {
  it("shows the error and loads and plays the song on retry", async () => {
    const songId = nextSong();
    controller.prepareEngine(); // creates the engine
    engine().failInit = 2; // the tap and the load both fail
    controller.prepareEngine();
    await openSong(songId, [track("a")], null, {}, "", info(songId));
    expect(useRehearse.getState().status).toBe("error");
    expect(engine().loads).toHaveLength(0);
    togglePlay(); // in the error state, play retries (inside the tap)
    await vi.waitFor(() => {
      expect(engine().loads).toHaveLength(1);
    });
    await vi.waitFor(() => {
      expect(engine().plays).toBe(1);
    });
    expect(useRehearse.getState().status).toBe("playing");
  });

  it("retryAudio reloads even when the song had loaded before", async () => {
    const songId = nextSong();
    await openSong(songId, [track("a")], null, {}, "", info(songId));
    expect(engine().loads).toHaveLength(1);
    engine().setState("error"); // e.g. a context rebuild failed
    retryAudio();
    await vi.waitFor(() => {
      expect(engine().loads).toHaveLength(2);
    });
    await vi.waitFor(() => {
      expect(engine().plays).toBe(1);
    });
  });
});

describe("A/B selection (listened versions)", () => {
  it("keeps the chosen version across a track refresh without reloading", async () => {
    const songId = nextSong();
    const b = version("a-v2", "a2");
    await openSong(songId, [track("a")], null, {}, "", info(songId));
    expect(engine().loads).toHaveLength(1);
    controller.listenToVersion("a", b);
    expect(engine().switches).toEqual([{ trackId: "a", hash: "a2", trimDb: 0 }]);
    // An SSE "tracks" change refreshes the track list; the saved mix has not caught up yet.
    await openSong(songId, [track("a")], null, {}, "", info(songId));
    expect(engine().loads).toHaveLength(1); // no reload, no rebuffer
    expect(useRehearse.getState().tracks[0]?.version.id).toBe("a-v2");
    expect(useRehearse.getState().mix.tracks.a?.listenedVersionId).toBe("a-v2");
  });

  it("reloads with the chosen version when the song's audio really changes", async () => {
    const songId = nextSong();
    await openSong(songId, [track("a")], null, {}, "", info(songId));
    controller.listenToVersion("a", version("a-v2", "a2"));
    await openSong(songId, [track("a"), track("b")], null, {}, "", info(songId)); // a track was added
    expect(engine().loads).toHaveLength(2);
    const hashes = engine().loads[1]?.tracks.map((t) => t.clips[0]?.variant.hash);
    expect(hashes).toEqual(["a2", "b1"]);
  });
});

describe("version gain (SPEC §25.6)", () => {
  it("loads with each version's gain and applies a changed gain without reloading", async () => {
    const songId = nextSong();
    const loud = { ...version("b-v1", "b1"), gainDb: 4.5 };
    await openSong(songId, [track("a"), track("b", loud)], null, {}, "", info(songId));
    expect(
      engine()
        .loads.at(-1)
        ?.tracks.map((t) => t.trimDb),
    ).toEqual([0, 4.5]);
    await openSong(
      songId,
      [track("a", { ...version("a-v1", "a1"), gainDb: -3 }), track("b", loud)],
      null,
      {},
      "",
      info(songId),
    );
    expect(engine().loads).toHaveLength(1);
    expect(engine().trims).toEqual([{ trackId: "a", trimDb: -3 }]);
    // Listening to another version brings that version's gain.
    controller.listenToVersion("b", { ...version("b-v2", "b2"), gainDb: -1 });
    expect(engine().switches.at(-1)).toEqual({ trackId: "b", hash: "b2", trimDb: -1 });
  });
});

describe("per-track errors", () => {
  it("clears a track's error once it has audio buffered again", async () => {
    await openSong("errors-song", [track("a"), track("b")], null, {}, "", info("errors-song"));
    engine().emit("error", { trackId: "a", message: "HTTP 503" });
    engine().emit("error", { trackId: "b", message: "HTTP 404" });
    expect(Object.keys(useRehearse.getState().errors)).toEqual(["a", "b"]);
    engine().emit("buffer", { a: 0, b: 0 });
    expect(Object.keys(useRehearse.getState().errors)).toEqual(["a", "b"]);
    engine().emit("buffer", { a: 1.5, b: 0 });
    expect(useRehearse.getState().errors).toEqual({ b: "HTTP 404" });
    expect(useRehearse.getState().buffer).toEqual({ a: 1.5, b: 0 });
  });
});

describe("offline with a listened version", () => {
  it("plays the current version when the listened one is not on the device", async () => {
    const { useOffline } = await import("../offline/controller");
    const { useOnlineState } = await import("../offline/online");
    const songId = nextSong();
    const b = version("a-v2", "a2");
    const saved = {
      tracks: {
        a: { gainDb: 0, pan: 0, mute: false, solo: false, listenedVersionId: "a-v2" },
      },
    };
    useOffline.setState({
      items: [
        {
          key: `song:${songId}`,
          kind: "song",
          id: songId,
          title: "",
          projectId: "p",
          addedAt: 0,
          syncedAt: 0,
          autoUpdate: true,
          quality: "normal",
          lossless: false,
          status: "ready",
          error: null,
          bytes: 0,
          blobs: ["a1"],
          urls: [],
          songIds: [songId],
        },
      ],
    });
    useOnlineState.setState({ online: false });
    try {
      await openSong(songId, [track("a")], saved, { a: b }, "", info(songId));
      expect(engine().loads.at(-1)?.tracks[0]?.clips[0]?.variant.hash).toBe("a1");
      // The choice is kept for when the version is available again.
      expect(useRehearse.getState().mix.tracks.a?.listenedVersionId).toBe("a-v2");
      // With the version on the device, it plays.
      const item = useOffline.getState().items[0];
      if (item) useOffline.setState({ items: [{ ...item, blobs: ["a1", "a2"] }] });
      await openSong("other-song", [track("a")], null, {}, "", info("other-song"));
      await openSong(songId, [track("a")], saved, { a: b }, "", info(songId));
      expect(engine().loads.at(-1)?.tracks[0]?.clips[0]?.variant.hash).toBe("a2");
    } finally {
      useOnlineState.setState({ online: true });
      useOffline.setState({ items: [] });
    }
  });
});

describe("song lifecycle and queue (SPEC §6.10)", () => {
  const songOf = (id: string) =>
    ({
      id,
      title: `Title ${id}`,
      subtitle: "",
      project: { id: "p", name: "P", color: "blue", imageHash: null },
    }) as unknown as Song;
  const loaderFor = (fail: string[] = [], fresh: ReturnType<typeof entry>[] = []) => {
    const loaded: string[] = [];
    const loader: QueueLoader = {
      entries: () => Promise.resolve(fresh),
      load(id) {
        loaded.push(id);
        if (fail.includes(id)) return Promise.reject(new Error("gone"));
        return Promise.resolve({
          song: songOf(id),
          tracks: [track(`${id}-t`)],
          saved: null,
          listened: {},
          tempo: null,
        });
      },
    };
    return { loader, loaded };
  };
  const entry = (songId: string, ready = true) => ({ songId, title: songId, subtitle: "", ready });
  const source = { kind: "project" as const, projectId: "p", projectName: "P", imageHash: null };

  it("leaving a stopped song closes it; a playing one plays on until the end", async () => {
    const a = nextSong();
    const detach = controller.attachPage(a);
    await openSong(a, [track("a")], null, {}, "", info(a));
    expect(useRehearse.getState().open).toBe(true);
    detach();
    expect(useRehearse.getState().open).toBe(false);

    const b = nextSong();
    const detachB = controller.attachPage(b);
    await openSong(b, [track("b")], null, {}, "", info(b));
    togglePlay();
    detachB();
    expect(useRehearse.getState().open).toBe(true);
    expect(engine().state).toBe("playing");
    // The song ends while the user is elsewhere and nothing follows: the player closes.
    engine().setState("stopped");
    engine().emit("ended", undefined);
    expect(useRehearse.getState().open).toBe(false);
  });

  it("an ended song stays on its own page", async () => {
    const a = nextSong();
    const detach = controller.attachPage(a);
    await openSong(a, [track("a")], null, {}, "", info(a));
    engine().emit("ended", undefined);
    expect(useRehearse.getState().open).toBe(true);
    expect(useRehearse.getState().ended).toBe(true);
    detach();
  });

  it("plays the queue's ready songs one after another, skipping unloadable ones", async () => {
    const { loader, loaded } = loaderFor(["q3"]);
    const entries = [entry("q1"), entry("q2", false), entry("q3"), entry("q4")];
    expect(controller.startQueue(entries, source, loader)).toBe(true);
    await vi.waitFor(() => {
      expect(useRehearse.getState().songId).toBe("q1");
    });
    await vi.waitFor(() => {
      expect(engine().state).toBe("playing");
    });
    expect(useRehearse.getState().info?.title).toBe("Title q1");
    expect(controller.hasNextSong()).toBe(true);
    expect(controller.hasPreviousSong()).toBe(false);
    engine().setState("stopped");
    engine().emit("ended", undefined);
    await vi.waitFor(() => {
      expect(useRehearse.getState().songId).toBe("q4");
    });
    await vi.waitFor(() => {
      expect(engine().state).toBe("playing");
    });
    expect(loaded).toEqual(["q1", "q3", "q4"]);
    expect(useRehearse.getState().queue?.index).toBe(3);
    expect(controller.hasNextSong()).toBe(false);
    // Previous tries the ready song before it (q3 still fails: q4, already loaded, plays from the start).
    controller.previousSong();
    await vi.waitFor(() => {
      expect(loaded).toEqual(["q1", "q3", "q4", "q3"]);
    });
    await vi.waitFor(() => {
      expect(useRehearse.getState().queue?.index).toBe(3);
    });
  });

  it("asks again at the end for songs that were still processing", async () => {
    const { loader } = loaderFor([], [entry("r1"), entry("r2")]);
    controller.startQueue([entry("r1"), entry("r2", false)], source, loader);
    await vi.waitFor(() => {
      expect(useRehearse.getState().songId).toBe("r1");
    });
    expect(controller.hasNextSong()).toBe(false);
    engine().setState("stopped");
    engine().emit("ended", undefined);
    await vi.waitFor(() => {
      expect(useRehearse.getState().songId).toBe("r2");
    });
    expect(useRehearse.getState().queue?.entries.every((e) => e.ready)).toBe(true);
  });

  it("nothing ready: does not start", () => {
    const { loader, loaded } = loaderFor();
    expect(controller.startQueue([entry("x", false)], source, loader)).toBe(false);
    expect(loaded).toEqual([]);
  });

  it("a deleted song leaves the queue; deleting the loaded one stops", async () => {
    const { loader } = loaderFor();
    controller.startQueue([entry("d1"), entry("d2")], source, loader);
    await vi.waitFor(() => {
      expect(useRehearse.getState().songId).toBe("d1");
    });
    expect(controller.dropSongs({ songIds: ["d2"] })).toBe("removed");
    expect(useRehearse.getState().queue?.entries.map((e) => e.songId)).toEqual(["d1"]);
    expect(controller.dropSongs({ songIds: ["d1"] })).toBe("stopped");
    expect(useRehearse.getState().open).toBe(false);
    expect(useRehearse.getState().queue).toBeNull();
  });

  it("deleting the stopped song on its own page closes it without a notice", async () => {
    const id = nextSong();
    const detach = controller.attachPage(id);
    await openSong(id, [track("a")], null, {}, "", info(id));
    expect(controller.dropSongs({ songIds: [id] })).toBe("removed");
    expect(useRehearse.getState().open).toBe(false);
    detach();
  });

  it("a song paused in the mini-player keeps the engine; the opened page shows a preview", async () => {
    const { loader } = loaderFor();
    controller.startQueue([entry("f1"), entry("f2")], source, loader);
    await vi.waitFor(() => {
      expect(engine().state).toBe("playing");
    });
    controller.pause();
    engine().loads = [];
    const detach = controller.attachPage("f3");
    await openSong("f3", [track("f3-t")], null, {}, "", { ...info("f3"), projectId: "p" });
    expect(engine().loads).toHaveLength(0);
    expect(useRehearse.getState().songId).toBe("f1");
    expect(useRehearse.getState().open).toBe(true);
    expect(useRehearse.getState().previewSongId).toBe("f3");
    expect(controller.pageState().songId).toBe("f3");
    // Play on the page switches the engine to it.
    controller.togglePagePlay();
    await vi.waitFor(() => {
      expect(useRehearse.getState().songId).toBe("f3");
    });
    expect(useRehearse.getState().previewSongId).toBeNull();
    expect(engine().loads).toHaveLength(1);
    detach();
  });
});

describe("another song's page while a song plays (SPEC §6.10)", () => {
  const songOf = (id: string) =>
    ({
      id,
      title: `Title ${id}`,
      subtitle: "",
      project: { id: "p", name: "P", color: "blue", imageHash: null },
    }) as unknown as Song;
  const loader: QueueLoader = {
    entries: () => Promise.resolve([]),
    load: (id) =>
      Promise.resolve({
        song: songOf(id),
        tracks: [track(`${id}-t`)],
        saved: null,
        listened: {},
        tempo: null,
      }),
  };
  const entry = (songId: string) => ({ songId, title: songId, subtitle: "", ready: true });
  const source = { kind: "project" as const, projectId: "p", projectName: "P", imageHash: null };

  /** A queue of `ids` playing its first song. */
  async function playing(ids: string[]) {
    controller.startQueue(ids.map(entry), source, loader);
    await vi.waitFor(() => {
      expect(useRehearse.getState().songId).toBe(ids[0]);
    });
    await vi.waitFor(() => {
      expect(engine().state).toBe("playing");
    });
    engine().loads = [];
    engine().loops = [];
    engine().plays = 0;
  }

  /** The page of `id` opens (attach, then its data arrives). */
  async function openPage(id: string, tracks = [track(`${id}-t`)]) {
    const detach = controller.attachPage(id);
    await openSong(id, tracks, null, {}, "", info(id));
    return detach;
  }

  it("shows the opened song without loading it; the playing song and queue go on", async () => {
    await playing(["p1", "p2"]);
    const detach = await openPage("p3", [track("x"), track("y")]);
    expect(engine().loads).toHaveLength(0);
    expect(engine().state).toBe("playing");
    const s = useRehearse.getState();
    expect(s.songId).toBe("p1");
    expect(s.open).toBe(true);
    expect(s.previewSongId).toBe("p3");
    expect(s.queue?.entries.map((e) => e.songId)).toEqual(["p1", "p2"]);
    const preview = controller.usePreview.getState();
    expect(preview.songId).toBe("p3");
    expect(preview.tracks.map((p) => p.track.id)).toEqual(["x", "y"]);
    expect(preview.status).toBe("stopped");
    expect(preview.lengthSec).toBe(10);
    expect(controller.pageState().songId).toBe("p3");
    expect(controller.pageIsPlaying()).toBe(false);
    // The queue moving on keeps the preview.
    engine().setState("stopped");
    engine().emit("ended", undefined);
    await vi.waitFor(() => {
      expect(useRehearse.getState().songId).toBe("p2");
    });
    expect(useRehearse.getState().previewSongId).toBe("p3");
    detach();
    expect(useRehearse.getState().previewSongId).toBeNull();
    expect(controller.usePreview.getState().songId).toBeNull();
    expect(useRehearse.getState().open).toBe(true);
  });

  it("mixer edits on the preview save for its song and leave the engine alone", async () => {
    await playing(["m1"]);
    const detach = await openPage("m2", [track("a")]);
    apiMock.mockClear();
    engine().gains = [];
    controller.setTrack("a", { gainDb: -6 });
    expect(controller.usePreview.getState().mix.tracks.a?.gainDb).toBe(-6);
    expect(engine().gains).toEqual([]);
    controller.listenToVersion("a", version("a-v2", "a2"));
    expect(engine().switches).toEqual([]);
    expect(controller.usePreview.getState().tracks[0]?.version.id).toBe("a-v2");
    detach(); // leaving the page saves the preview's mix
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls[0]).toMatchObject([
      expect.anything(),
      {
        params: { id: "m2" },
        body: { state: { tracks: { a: { gainDb: -6, listenedVersionId: "a-v2" } } } },
      },
    ]);
  });

  it("Play switches the engine to the page's song from its position and ends the queue", async () => {
    await playing(["s1", "s2"]);
    const detach = await openPage("s3", [track("a")]);
    controller.seekSec(4);
    expect(controller.positionSec()).toBe(4);
    expect(engine().seeks).toEqual([]);
    controller.setLoopSec({ start: 2, end: 6 });
    controller.setTrack("a", { mute: true });
    controller.togglePagePlay();
    expect(useRehearse.getState().songId).toBe("s3");
    expect(useRehearse.getState().previewSongId).toBeNull();
    expect(useRehearse.getState().queue?.entries.map((e) => e.songId)).toEqual(["s3"]);
    await vi.waitFor(() => {
      expect(engine().plays).toBe(1);
    });
    expect(engine().loads).toHaveLength(1);
    expect(engine().seeks).toEqual([4 * 48_000]);
    expect(useRehearse.getState().mix.tracks.a?.mute).toBe(true);
    expect(controller.pageIsPlaying()).toBe(true);
    expect(controller.usePreview.getState().songId).toBeNull();
    // From now on the page is the normal Player: a refresh does not reload.
    await openSong("s3", [track("a")], null, {}, "", info("s3"));
    expect(engine().loads).toHaveLength(1);
    detach();
  });

  it("the page loads its song (stopped) when the playing song is closed", async () => {
    await playing(["c1"]);
    const detach = await openPage("c2");
    controller.pause(); // paused in the mini-player: the preview stays
    await openSong("c2", [track("c2-t")], null, {}, "", info("c2"));
    expect(useRehearse.getState().previewSongId).toBe("c2");
    expect(engine().loads).toHaveLength(0);
    controller.closeSong(); // ✕ in the mini-player
    expect(useRehearse.getState().songId).toBe("c2");
    expect(useRehearse.getState().open).toBe(true);
    expect(useRehearse.getState().previewSongId).toBeNull();
    await vi.waitFor(() => {
      expect(engine().loads).toHaveLength(1);
    });
    expect(engine().plays).toBe(0);
    detach();
  });

  it("the page loads its song when the queue ends elsewhere", async () => {
    await playing(["e1"]);
    const detach = await openPage("e2");
    engine().setState("stopped");
    engine().emit("ended", undefined);
    expect(useRehearse.getState().songId).toBe("e2");
    await vi.waitFor(() => {
      expect(engine().loads).toHaveLength(1);
    });
    expect(engine().plays).toBe(0);
    detach();
  });

  it("the queue reaching the previewed song makes the page the Player again", async () => {
    await playing(["r1", "r2"]);
    const detach = await openPage("r2");
    expect(useRehearse.getState().previewSongId).toBe("r2");
    engine().setState("stopped");
    engine().emit("ended", undefined);
    await vi.waitFor(() => {
      expect(useRehearse.getState().songId).toBe("r2");
    });
    expect(useRehearse.getState().previewSongId).toBeNull();
    await vi.waitFor(() => {
      expect(engine().state).toBe("playing");
    });
    expect(useRehearse.getState().queue?.index).toBe(1);
    detach();
  });

  it("decides on attaching: the page's first calls before its data do not touch the engine", async () => {
    await playing(["a1"]);
    const detach = controller.attachPage("a2");
    expect(useRehearse.getState().previewSongId).toBe("a2");
    expect(controller.pageState().songId).not.toBe("a2"); // the Player shows a loader
    controller.setLoopSec(null); // the timeline resets for the new song
    expect(engine().loops).toEqual([]);
    // ✕ before the data arrived: the page's openSong then loads its song.
    controller.closeSong();
    expect(useRehearse.getState().previewSongId).toBeNull();
    await openSong("a2", [track("a2-t")], null, {}, "", info("a2"));
    expect(useRehearse.getState().songId).toBe("a2");
    expect(engine().loads).toHaveLength(1);
    detach();
  });

  it("stopPlayer (logout) does not load the previewed song", async () => {
    await playing(["l1"]);
    const detach = await openPage("l2");
    controller.stopPlayer();
    expect(useRehearse.getState().open).toBe(false);
    expect(useRehearse.getState().songId).toBe("l1");
    detach();
    expect(engine().loads).toHaveLength(0);
  });
});
