import type { Track, TrackVersion } from "@bandroom/shared";
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
    seek() {}
    setLoop() {}
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

let song = 0;
/** A fresh song id per test: the controller's module state persists across tests. */
const nextSong = () => `song-${++song}`;

beforeEach(() => {
  const e = fake.FakeEngine.instance;
  if (e) {
    e.loads = [];
    e.switches = [];
    e.trims = [];
    e.gains = [];
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
    await openSong(songId, [track("a")], null, {}, "");
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
    await openSong(songId, [track("a")], null, {}, "");
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

describe("Listen mode takes the audio", () => {
  it("suspends the engine", async () => {
    const { claimAudio } = await import("../player/exclusive");
    await openSong(nextSong(), [track("a")], null, {}, "");
    togglePlay();
    expect(engine().state).toBe("playing");
    claimAudio("listen");
    expect(engine().suspended).toBe(1);
    expect(engine().state).toBe("stopped");
  });
});

describe("A/B selection (listened versions)", () => {
  it("keeps the chosen version across a track refresh without reloading", async () => {
    const songId = nextSong();
    const b = version("a-v2", "a2");
    await openSong(songId, [track("a")], null, {}, "");
    expect(engine().loads).toHaveLength(1);
    controller.listenToVersion("a", b);
    expect(engine().switches).toEqual([{ trackId: "a", hash: "a2", trimDb: 0 }]);
    // An SSE "tracks" change refreshes the track list; the saved mix has not caught up yet.
    await openSong(songId, [track("a")], null, {}, "");
    expect(engine().loads).toHaveLength(1); // no reload, no rebuffer
    expect(useRehearse.getState().tracks[0]?.version.id).toBe("a-v2");
    expect(useRehearse.getState().mix.tracks.a?.listenedVersionId).toBe("a-v2");
  });

  it("reloads with the chosen version when the song's audio really changes", async () => {
    const songId = nextSong();
    await openSong(songId, [track("a")], null, {}, "");
    controller.listenToVersion("a", version("a-v2", "a2"));
    await openSong(songId, [track("a"), track("b")], null, {}, ""); // a track was added
    expect(engine().loads).toHaveLength(2);
    const hashes = engine().loads[1]?.tracks.map((t) => t.clips[0]?.variant.hash);
    expect(hashes).toEqual(["a2", "b1"]);
  });
});

describe("version gain (SPEC §25.6)", () => {
  it("loads with each version's gain and applies a changed gain without reloading", async () => {
    const songId = nextSong();
    const loud = { ...version("b-v1", "b1"), gainDb: 4.5 };
    await openSong(songId, [track("a"), track("b", loud)], null, {}, "");
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
    await openSong(nextSong(), [track("a"), track("b")], null, {}, "");
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
      await openSong(songId, [track("a")], saved, { a: b }, "");
      expect(engine().loads.at(-1)?.tracks[0]?.clips[0]?.variant.hash).toBe("a1");
      // The choice is kept for when the version is available again.
      expect(useRehearse.getState().mix.tracks.a?.listenedVersionId).toBe("a-v2");
      // With the version on the device, it plays.
      const item = useOffline.getState().items[0];
      if (item) useOffline.setState({ items: [{ ...item, blobs: ["a1", "a2"] }] });
      await openSong(nextSong(), [track("a")], null, {}, "");
      await openSong(songId, [track("a")], saved, { a: b }, "");
      expect(engine().loads.at(-1)?.tracks[0]?.clips[0]?.variant.hash).toBe("a2");
    } finally {
      useOnlineState.setState({ online: true });
      useOffline.setState({ items: [] });
    }
  });
});

describe("default mix while the song's mix is prepared (SPEC §25.5)", () => {
  const saved = { tracks: { a: { gainDb: 3, pan: 0, mute: false, solo: false } } };
  const quiet = { ...track("a"), defaultGainDb: -6 };

  it("plays the track defaults, never saves them, and switches mixes over the same audio", async () => {
    const songId = nextSong();
    apiMock.mockClear();
    await openSong(songId, [quiet], saved, {}, "", "default");
    expect(useRehearse.getState().mix.tracks.a?.gainDb).toBe(-6);
    expect(engine().loads).toHaveLength(1);
    controller.closeSong();
    expect(apiMock).not.toHaveBeenCalled();

    // Mixer on: the personal mix over the loaded audio, without a reload.
    await openSong(songId, [quiet], saved, {}, "", "mixer");
    expect(engine().loads).toHaveLength(1);
    expect(useRehearse.getState().mix.tracks.a?.gainDb).toBe(3);
    expect(engine().gains.at(-1)).toEqual({ trackId: "a", gainDb: 3 });

    // Mixer off again: the personal mix is saved first, then the defaults play.
    controller.setTrack("a", { gainDb: 1 });
    await openSong(songId, [quiet], saved, {}, "", "default");
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(useRehearse.getState().mix.tracks.a?.gainDb).toBe(-6);
    expect(engine().gains.at(-1)).toEqual({ trackId: "a", gainDb: -6 });
    controller.setTrack("a", { gainDb: 0 });
    controller.closeSong();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
