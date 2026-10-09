import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AudioEngine from "@bandroom/audio-engine";
import type { RecordedTake } from "@bandroom/audio-engine";

type Listener = (e: unknown) => void;

const fake = vi.hoisted(() => {
  class FakeEngine {
    recordingState = "off";
    armed: { channels: number; maxFrames: number }[] = [];
    started: unknown[] = [];
    stops: string[] = [];
    disarms = 0;
    latency = { outputSec: 0.02, inputSec: 0.005 };
    listeners = new Map<string, Set<Listener>>();
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
    armRecording(o: { channels: number; maxFrames: number }) {
      this.armed.push(o);
      this.recordingState = "armed";
      return Promise.resolve();
    }
    startRecording(o: unknown) {
      this.started.push(o);
      this.recordingState = "recording";
    }
    take: RecordedTake = {
      startFrame: 96_000,
      frames: 48_000,
      channels: 1,
      gapFrames: 0,
      endedBy: "user",
      confirmed: true,
    };
    stopRecording(reason: string) {
      this.stops.push(reason);
      this.recordingState = "armed";
      const t = { ...this.take, endedBy: reason } as RecordedTake;
      this.emit("take", t);
      return Promise.resolve(t);
    }
    disarmRecording() {
      this.disarms++;
      this.recordingState = "off";
    }
    recordingLatency() {
      return this.latency;
    }
  }
  return { engine: new FakeEngine() };
});

const ctl = vi.hoisted(() => ({
  modes: [] as boolean[],
  holds: [] as boolean[],
  practiceReset: true,
}));

vi.mock("../rehearse/controller", () => ({
  recordingEngine: () => fake.engine,
  maxTakeFrames: () => 180 * 60 * 48_000,
  countInForRecording: () => ({ clicks: 4, perBar: 4, intervalFrames: 26_181.8 }),
  resetPracticeForRecording: () => ctl.practiceReset,
  setRecordingMode: (on: boolean) => ctl.modes.push(on),
  holdScreenForRecording: (on: boolean) => ctl.holds.push(on),
}));

const sessions = vi.hoisted(() => [] as boolean[]);
vi.mock("@bandroom/audio-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof AudioEngine>()),
  setRecordingAudioSession: (on: boolean) => sessions.push(on),
}));

const rec = await import("./recorder");
const { useTimelineUi } = await import("../markers/store");

function stream(label = "MacBook Pro Microphone", channelCount = 2) {
  const stopped: string[] = [];
  const track = {
    label,
    getSettings: () => ({ channelCount }),
    stop: () => stopped.push(label),
  };
  return {
    stream: {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream,
    stopped,
  };
}

const port = {} as MessagePort;

beforeEach(() => {
  rec.disarmRecorder();
  fake.engine.armed = [];
  fake.engine.stops = [];
  fake.engine.started = [];
  fake.engine.latency = { outputSec: 0.02, inputSec: 0.005 };
  ctl.modes = [];
  ctl.holds = [];
  sessions.length = 0;
  rec.clearTake();
});

describe("recorder (SPEC §9)", () => {
  it("asks for the raw input: no echo cancellation, noise suppression or gain control", () => {
    expect(rec.inputConstraints({ deviceId: "mic2", channels: 1 })).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 1 },
      deviceId: { exact: "mic2" },
    });
    expect(rec.inputConstraints({})).not.toHaveProperty("deviceId");
  });

  it("arms: practice notice, loop off, play-and-record, screen on, max take length", async () => {
    useTimelineUi.setState({ loopOn: true });
    const { stream: s } = stream();
    await rec.armRecorder({ stream: s, channels: 2, port });
    expect(fake.engine.armed[0]).toMatchObject({ channels: 2, maxFrames: 180 * 60 * 48_000 });
    expect(useTimelineUi.getState().loopOn).toBe(false);
    expect(sessions).toEqual([true]);
    expect(ctl.holds).toEqual([true]);
    expect(rec.useRecorder.getState()).toMatchObject({
      phase: "armed",
      channels: 2,
      inputChannels: 2,
      practiceReset: true,
      bluetooth: false,
    });
  });

  it("warns about Bluetooth", async () => {
    await rec.armRecorder({ stream: stream("AirPods Pro").stream, channels: 1, port });
    expect(rec.useRecorder.getState().bluetooth).toBe(true);
    rec.disarmRecorder();
    fake.engine.latency = { outputSec: 0.15, inputSec: 0 };
    await rec.armRecorder({ stream: stream().stream, channels: 1, port });
    expect(rec.useRecorder.getState().bluetooth).toBe(true);
  });

  it("meters the input and keeps the clip indicator until reset", async () => {
    await rec.armRecorder({ stream: stream().stream, channels: 1, port });
    fake.engine.emit("input", { peaks: [0.5, 1], recFrames: 0 });
    fake.engine.emit("input", { peaks: [0.1, 0.1], recFrames: 0 });
    expect(rec.useRecorder.getState()).toMatchObject({ peaks: [0.1, 0.1], clipped: true });
    rec.resetClip();
    expect(rec.useRecorder.getState().clipped).toBe(false);
  });

  it("records with the count-in and places the take earlier by the latency", async () => {
    await rec.armRecorder({ stream: stream().stream, channels: 1, port });
    rec.startRecorder();
    expect(ctl.modes).toEqual([true]);
    expect(fake.engine.started[0]).toMatchObject({ countIn: { clicks: 4 } });
    expect(rec.useRecorder.getState().phase).toBe("recording");
    const take = await rec.stopRecorder();
    // 25 ms + one quantum = 1328 frames.
    expect(take).toMatchObject({ latencyFrames: 1328, offsetSamples: 94_672, trimHead: 0 });
    expect(rec.useRecorder.getState()).toMatchObject({ phase: "armed", take });
    expect(ctl.modes).toEqual([true, false]);
    expect(rec.placeFinishedTake(take, 10)).toEqual({ offsetSamples: 95_152, trimHead: 0 });
  });

  it("ends the take when the page is hidden, keeping it for the stop dialog", async () => {
    await rec.armRecorder({ stream: stream().stream, channels: 1, port });
    rec.startRecorder();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    expect(fake.engine.stops).toEqual(["hidden"]);
    expect(rec.useRecorder.getState().take?.endedBy).toBe("hidden");
  });

  it("disarms: closes the microphone and restores the session and screen", async () => {
    const { stream: s, stopped } = stream();
    await rec.armRecorder({ stream: s, channels: 1, port });
    rec.disarmRecorder();
    expect(stopped).toEqual(["MacBook Pro Microphone"]);
    expect(sessions).toEqual([true, false]);
    expect(ctl.holds).toEqual([true, false]);
    expect(rec.useRecorder.getState().phase).toBe("off");
    // Hidden again: nothing to stop any more.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fake.engine.stops).toEqual([]);
  });
});
