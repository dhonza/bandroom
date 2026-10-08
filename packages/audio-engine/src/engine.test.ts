import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, type EngineState } from "./engine";
import type { MixerCommand } from "./mixer/protocol";
import type { SongTimeline, WorkerCommand } from "./types";

/**
 * The main-thread `Engine` against minimal fakes of the Web Audio and Worker APIs: no audio is
 * rendered; the fake worker answers `load` the way the mixer does.
 */

class FakePort {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  sent: MixerCommand[] = [];
  postMessage(msg: MixerCommand) {
    this.sent.push(msg);
  }
  deliver(data: unknown) {
    this.onmessage?.({ data });
  }
}

class FakeContext {
  static all: FakeContext[] = [];
  static failAddModule = 0;
  sampleRate = 48_000;
  currentTime = 0;
  state: string = "suspended";
  destination = {};
  onstatechange: (() => void) | null = null;
  resumes = 0;
  suspends = 0;
  audioWorklet = {
    addModule: () =>
      FakeContext.failAddModule-- > 0
        ? Promise.reject(new Error("addModule failed"))
        : Promise.resolve(),
  };
  constructor() {
    FakeContext.all.push(this);
  }
  private set(state: string) {
    if (this.state === state) return;
    this.state = state;
    this.onstatechange?.();
  }
  resume() {
    this.resumes++;
    if (this.state !== "closed") this.set("running");
    return Promise.resolve();
  }
  suspend() {
    this.suspends++;
    if (this.state !== "closed") this.set("suspended");
    return Promise.resolve();
  }
  close() {
    this.set("closed");
    return Promise.resolve();
  }
}

class FakeNode {
  static last: FakeNode | null = null;
  port = new FakePort();
  constructor() {
    FakeNode.last = this;
  }
  connect() {}
  disconnect() {}
}

class FakeWorker {
  static all: FakeWorker[] = [];
  /** Loads are acknowledged by the test (`ack`) instead of right away. */
  static manual = false;
  static loads: number[] = [];
  static commands: WorkerCommand[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(cmd: WorkerCommand) {
    FakeWorker.commands.push(cmd);
    if (cmd.t !== "load") return;
    // The decoder forwards `load` to the mixer, which acknowledges it.
    FakeWorker.loads.push(cmd.id);
    if (!FakeWorker.manual)
      queueMicrotask(() => {
        ack(cmd.id);
      });
  }
  terminate() {
    this.terminated = true;
  }
}

function ack(id: number) {
  FakeNode.last?.port.deliver({ type: "loaded", id });
}

const song: SongTimeline = { lengthFrames: 48_000 * 10, tracks: [] };

let states: EngineState[];
function engine() {
  const e = new Engine({ workerUrl: "w.js", workletUrl: "m.js", cacheBytes: 1 << 20 });
  states = [];
  e.on("state", (s) => states.push(s));
  return e;
}

beforeEach(() => {
  FakeContext.all = [];
  FakeContext.failAddModule = 0;
  FakeWorker.all = [];
  FakeWorker.manual = false;
  FakeWorker.loads = [];
  FakeWorker.commands = [];
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeNode);
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Engine start", () => {
  it("reports a failed start as an error and starts over on the next init", async () => {
    FakeContext.failAddModule = 1;
    const e = engine();
    await expect(e.init()).rejects.toThrow("addModule failed");
    expect(e.state).toBe("error");
    expect(FakeContext.all[0]?.state).toBe("closed");
    // A new tap: a fresh context, and the song loads.
    await e.loadSong(song);
    expect(FakeContext.all).toHaveLength(2);
    expect(e.state).toBe("stopped");
    expect(states).toEqual(["error", "loading", "stopped"]);
  });

  it("reports a missing AudioContext as an error", async () => {
    vi.stubGlobal("AudioContext", function NoAudio() {
      throw new Error("not allowed");
    });
    const e = engine();
    await expect(e.loadSong(song)).rejects.toThrow("not allowed");
    expect(e.state).toBe("error");
  });
});

describe("Engine idle suspend", () => {
  const ctx = () => {
    const c = FakeContext.all.at(-1);
    if (!c) throw new Error("no context");
    return c;
  };

  it("suspends the context after a while stopped and resumes it on play", async () => {
    vi.useFakeTimers();
    const e = new Engine({
      workerUrl: "w.js",
      workletUrl: "m.js",
      cacheBytes: 1 << 20,
      idleSuspendMs: 1000,
    });
    await e.loadSong(song);
    expect(ctx().state).toBe("running");
    vi.advanceTimersByTime(999);
    expect(ctx().suspends).toBe(0);
    vi.advanceTimersByTime(1);
    expect(ctx().state).toBe("suspended");
    // Not an interruption: nothing wanted to play.
    expect(e.state).toBe("stopped");
    const resumes = ctx().resumes;
    e.play(); // synchronous resume inside the tap (iOS)
    expect(ctx().resumes).toBe(resumes + 1);
    expect(ctx().state).toBe("running");
    FakeNode.last?.port.deliver({ type: "state", state: "playing" });
    vi.advanceTimersByTime(5000);
    expect(ctx().state).toBe("running"); // never while playing
    e.pause();
    FakeNode.last?.port.deliver({ type: "state", state: "stopped" });
    vi.advanceTimersByTime(1000);
    expect(ctx().state).toBe("suspended");
  });

  it("stops sending meters a second into silence", async () => {
    const e = engine();
    await e.loadSong({ lengthFrames: 48_000, tracks: [] });
    let meters = 0;
    e.on("meters", () => meters++);
    const report = (peak: number) => {
      FakeNode.last?.port.deliver({
        type: "report",
        frame: 0,
        lap: 0,
        time: 0,
        playing: false,
        preroll: 0,
        prerollInterval: 0,
        prerollClicks: 0,
        clicks: 0,
        peaks: new Float32Array([peak, peak]),
        underruns: new Float32Array(0),
      });
    };
    report(0.5);
    for (let i = 0; i < 40; i++) report(0);
    expect(meters).toBe(21); // the loud one and 20 silent ones (the fall-off)
    report(0.2);
    expect(meters).toBe(22);
  });
});

describe("Engine load ordering", () => {
  const twoTracks: SongTimeline = {
    lengthFrames: 48_000 * 10,
    tracks: ["a", "b"].map((id) => ({
      id,
      clips: [],
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
    })),
  };
  const sent = () => FakeNode.last?.port.sent.map((c) => c.t) ?? [];
  /** Waits until the engine has posted `n` loads to the worker. */
  const loadsPosted = (n: number) =>
    vi.waitFor(() => {
      expect(FakeWorker.loads).toHaveLength(n);
    });

  it("resolves only the latest of overlapping loads", async () => {
    FakeWorker.manual = true;
    const e = engine();
    const first = e.loadSong(song);
    await loadsPosted(1);
    const second = e.loadSong(twoTracks);
    await loadsPosted(2);
    expect(await first).toBe(false); // superseded
    const [id1, id2] = FakeWorker.loads as [number, number];
    ack(id1); // the first song's acknowledgement arrives late: ignored
    expect(e.state).toBe("loading");
    ack(id2);
    expect(await second).toBe(true);
    expect(e.state).toBe("stopped");
    expect(states).toEqual(["loading", "stopped"]);
  });

  it("holds seeks and track changes until the mixer has the song, in order", async () => {
    FakeWorker.manual = true;
    const e = engine();
    const loading = e.loadSong(twoTracks);
    await loadsPosted(1);
    const before = sent().length;
    e.setTrackState("b", { mute: true });
    e.seek(48_000);
    e.setLoop({ start: 0, end: 48_000 * 2 });
    expect(sent()).toHaveLength(before); // nothing overtakes the load
    ack(FakeWorker.loads[0] ?? 0);
    expect(await loading).toBe(true);
    expect(sent().slice(before)).toEqual(["track", "seek", "loop"]);
    // Once loaded, commands go straight to the mixer.
    e.seek(0);
    expect(sent().at(-1)).toBe("seek");
  });

  it("drops the superseded song's commands but keeps click settings", async () => {
    FakeWorker.manual = true;
    const e = engine();
    void e.loadSong(twoTracks);
    await loadsPosted(1);
    const before = sent().length;
    e.seek(48_000);
    e.setClick({ enabled: true });
    const next = e.loadSong(twoTracks);
    await loadsPosted(2);
    ack(FakeWorker.loads[1] ?? 0);
    expect(await next).toBe(true);
    expect(sent().slice(before)).toEqual(["click"]);
  });

  it("settles a load in flight when disposed", async () => {
    FakeWorker.manual = true;
    const e = engine();
    const loading = e.loadSong(song);
    await loadsPosted(1);
    e.dispose();
    expect(await loading).toBe(false);
    expect(e.state).toBe("idle");
  });
});

describe("Engine version gain (SPEC §25.6)", () => {
  it("loads, changes and switches a track's version gain", async () => {
    const e = engine();
    await e.loadSong({
      lengthFrames: 48_000,
      tracks: [{ id: "a", clips: [], gainDb: -3, pan: 0, mute: false, solo: false, trimDb: 6 }],
    });
    const load = FakeWorker.commands.find((c) => c.t === "load");
    expect(load?.t === "load" && load.mixer[0]?.trimDb).toBe(6);
    e.setTrackState("a", { trimDb: -2 });
    expect(FakeNode.last?.port.sent.at(-1)).toEqual({
      t: "track",
      index: 0,
      params: { trimDb: -2 },
    });
    // A quality switch keeps the version's gain; a version switch brings the new one.
    e.switchSource("a", []);
    e.switchSource("a", [], 1.5, 4);
    const sources = FakeWorker.commands.flatMap((c) =>
      c.t === "source" ? [[c.offsetDb, c.trimDb]] : [],
    );
    expect(sources).toEqual([
      [0, -2],
      [1.5, 4],
    ]);
  });
});

describe("Engine position", () => {
  it("holds the playhead at the loop start while a repeat count-in plays", async () => {
    const e = engine();
    await e.loadSong(song);
    const loop = { start: 48_000, end: 96_000 };
    e.setLoop(loop);
    const ctx = FakeContext.all.at(-1);
    if (!ctx) throw new Error("no context");
    e.play();
    FakeNode.last?.port.deliver({ type: "state", state: "playing" });
    const report = (frame: number, time: number, preroll = 0) => {
      FakeNode.last?.port.deliver({
        type: "report",
        frame,
        lap: 1 << 20,
        time,
        playing: true,
        preroll,
        prerollInterval: preroll > 0 ? 12_000 : 0,
        prerollClicks: preroll > 0 ? 4 : 0,
        clicks: 0,
        peaks: new Float32Array(2),
        underruns: new Float32Array(0),
      });
    };
    report(95_000, 1);
    ctx.currentTime = 1 + 3000 / 48_000; // 2000 frames past the loop end
    expect(e.getPositionFrames()).toBeCloseTo(loop.start + 2000, 3); // wraps
    e.setRepeatCountIn({ clicks: 4, perBar: 4, intervalFrames: 12_000 });
    expect(e.getPositionFrames()).toBe(loop.start); // the count-in plays first
    // The report after the wrap carries the count-in: the playhead still waits for it.
    report(loop.start, 2, 48_000);
    ctx.currentTime = 2.5;
    expect(e.getPositionFrames()).toBe(loop.start);
    ctx.currentTime = 3.25;
    expect(e.getPositionFrames()).toBeCloseTo(loop.start + 12_000, 3);
  });
});

describe("Engine practice speed and pitch (SPEC §30.5)", () => {
  const variant = {
    kind: "opus" as const,
    hash: "h",
    url: "u",
    seekIndexUrl: null,
    channels: 2,
    preSkip: 312,
    totalFrames: 480_000,
    sampleRate: 48_000,
  };
  const clips = [{ startFrame: 0, sourceOffsetFrame: 0, lengthFrames: 480_000, variant }];
  const drums = { transpose: false, profile: "percussive" as const, voiceBaseHz: 0 };
  const twoTracks: SongTimeline = {
    lengthFrames: 480_000,
    tracks: [
      { id: "gtr", clips, gainDb: 0, pan: 0, mute: false, solo: false },
      { id: "dr", clips, gainDb: 0, pan: 0, mute: false, solo: false, stretch: drums },
    ],
  };
  const loads = () => FakeWorker.commands.filter((c) => c.t === "load");
  const mixerSent = () => FakeNode.last?.port.sent ?? [];
  const report = (frame: number, time: number) => {
    FakeNode.last?.port.deliver({
      type: "report",
      frame,
      lap: 0,
      time,
      playing: true,
      preroll: 0,
      prerollInterval: 0,
      prerollClicks: 0,
      clicks: 0,
      peaks: new Float32Array(4),
      underruns: new Float32Array(2),
    });
  };

  it("loads in playback frames with per-track stretching", async () => {
    const e = engine();
    e.setPractice({ rate: 0.5, semitones: -2, quality: "economy" });
    await e.loadSong(twoTracks);
    const load = loads().at(-1);
    if (load?.t !== "load") throw new Error("no load");
    expect(load.lengthFrames).toBe(960_000);
    expect(load.tracks[0]?.stretch).toMatchObject({ rate: 0.5, semitones: -2, silent: false });
    expect(load.tracks[1]?.stretch).toMatchObject({ semitones: 0, profile: "percussive" });
    expect(load.mixer[0]?.clips).toEqual([{ start: 0, end: 960_000 }]);
    expect(e.lengthFrames).toBe(480_000); // the API stays in timeline frames
  });

  it("converts seeks, loops, the click and the count-in to playback frames", async () => {
    const e = engine();
    e.setPractice({ rate: 0.75, semitones: 0, quality: "high" });
    await e.loadSong(twoTracks);
    e.seek(48_000);
    expect(mixerSent().at(-1)).toMatchObject({ t: "seek", frame: 64_000 });
    e.setLoop({ start: 48_000, end: 96_000 });
    expect(mixerSent().at(-1)).toMatchObject({ t: "loop", loop: { start: 64_000, end: 128_000 } });
    expect(e.loopRange).toEqual({ start: 48_000, end: 96_000 });
    e.setClickTrack({ frames: new Float64Array([0, 24_000]), levels: new Uint8Array([2, 1]) });
    const click = mixerSent().at(-1);
    expect(click?.t === "clickTrack" && [...click.frames]).toEqual([0, 32_000]);
    e.setRepeatCountIn({ clicks: 4, perBar: 4, intervalFrames: 24_000 });
    expect(mixerSent().at(-1)).toMatchObject({ countIn: { intervalFrames: 32_000 } });
    e.play({ countIn: { clicks: 4, perBar: 4, intervalFrames: 12_000 } });
    expect(mixerSent().at(-1)).toMatchObject({ t: "play", countIn: { intervalFrames: 16_000 } });
    expect(e.lastCountInSpec?.intervalFrames).toBe(12_000);
  });

  it("reports the position in timeline frames", async () => {
    const e = engine();
    e.setPractice({ rate: 0.5, semitones: 0, quality: "high" });
    await e.loadSong(twoTracks);
    const ctx = FakeContext.all.at(-1);
    if (!ctx) throw new Error("no context");
    e.play();
    FakeNode.last?.port.deliver({ type: "state", state: "playing" });
    report(96_000, 1);
    ctx.currentTime = 1.5; // 24 000 output frames later = 12 000 timeline frames
    expect(e.getPositionFrames()).toBeCloseTo(48_000 + 12_000, 3);
  });

  it("reloads in place on a change, restoring position, loop and click", async () => {
    const e = engine();
    await e.loadSong(twoTracks);
    e.seek(96_000);
    e.setLoop({ start: 48_000, end: 144_000 });
    e.setClickTrack({ frames: new Float64Array([48_000]), levels: new Uint8Array([2]) });
    expect(loads()).toHaveLength(1);
    e.setPractice({ rate: 0.5, semitones: 3, quality: "high" });
    expect(loads()).toHaveLength(2);
    await vi.waitFor(() => {
      expect(mixerSent().findLast((c) => c.t === "seek")).toMatchObject({ frame: 192_000 });
    });
    expect(e.state).toBe("stopped");
    expect(mixerSent().findLast((c) => c.t === "loop")).toMatchObject({
      loop: { start: 96_000, end: 288_000 },
    });
    const click = mixerSent().findLast((c) => c.t === "clickTrack");
    expect(click?.t === "clickTrack" && [...click.frames]).toEqual([96_000]);
    expect(e.getPositionFrames()).toBe(96_000);
    // The same setting again changes nothing.
    e.setPractice({ rate: 0.5, semitones: 3, quality: "high" });
    expect(loads()).toHaveLength(2);
  });

  it("silences a muted track and switches it back in when unmuted", async () => {
    const e = engine();
    e.setPractice({ rate: 1, semitones: -1, quality: "high" });
    await e.loadSong(twoTracks);
    e.setTrackState("gtr", { mute: true });
    e.setTrackState("gtr", { gainDb: -3 }); // no source change
    e.setTrackState("gtr", { mute: false });
    const sources = FakeWorker.commands.flatMap((c) => (c.t === "source" ? [c] : []));
    expect(sources.map((c) => [c.index, c.source, c.stretch?.silent])).toEqual([
      [0, 2, true],
      [0, 3, false],
    ]);
    // Drums at 100 % play as is; muting them only needs a silent source too.
    e.setTrackState("dr", { mute: true });
    e.setTrackState("dr", { mute: false });
    const drum = FakeWorker.commands.flatMap((c) => (c.t === "source" && c.index === 1 ? [c] : []));
    expect(drum.map((c) => c.stretch?.silent ?? null)).toEqual([true, null]);
  });
});
