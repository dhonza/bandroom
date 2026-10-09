import { describe, expect, it } from "vitest";
import {
  CAPTURE_CHUNK_FRAMES,
  MixerCore,
  type MixerEvent,
  type MixerTrackConfig,
  type TakeMessage,
} from "./core";

const SR = 48_000;

const track = (over: Partial<MixerTrackConfig> = {}): MixerTrackConfig => ({
  id: "a",
  source: 1,
  channels: 2,
  clips: [{ start: 0, end: SR }],
  gainDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  ...over,
});

function setup(tracks: MixerTrackConfig[] = [], length = 0) {
  const events: MixerEvent[] = [];
  const m = new MixerCore((e) => events.push(structuredClone(e)));
  m.startFrames = 1024;
  m.load(tracks, length);
  return { m, events };
}

/** Feeds `[0, to)` of `lap` of track 0 with a constant. */
function feed(m: MixerCore, to: number, lap = 0, v = 0.5) {
  for (let f = 0; f < to; f += 4096) {
    const n = Math.min(4096, to - f);
    m.addChunk(0, 1, {
      lap,
      frame: f,
      length: n,
      data: [new Float32Array(n).fill(v), new Float32Array(n).fill(v)],
    });
  }
}

/**
 * Renders `blocks` blocks of 128 frames with an input whose sample value is its block-global
 * index (left) and minus that (right), so the take shows which input frames it holds.
 */
function run(m: MixerCore, blocks: number, from = 0, channels = 2) {
  const out0 = new Float32Array(128);
  const out1 = new Float32Array(128);
  const in0 = new Float32Array(128);
  const in1 = new Float32Array(128);
  for (let b = from; b < from + blocks; b++) {
    for (let i = 0; i < 128; i++) {
      in0[i] = b * 128 + i;
      in1[i] = -(b * 128 + i);
    }
    m.mixBlock(out0, out1, 128, b / 375, channels === 2 ? [in0, in1] : [in0]);
  }
  return from + blocks;
}

const pool = (m: MixerCore, n: number, channels = 1) => {
  for (let i = 0; i < n; i++) m.addCaptureBuffer(new Float32Array(CAPTURE_CHUNK_FRAMES * channels));
};

const takes = (ev: MixerEvent[]) => ev.filter((e): e is TakeMessage => e.type.startsWith("take."));

/** The take's samples (interleaved) from its chunks, with gaps as NaN. */
function samples(ev: MixerEvent[]): number[] {
  const out: number[] = [];
  for (const e of takes(ev)) {
    if (e.type === "take.chunk") out.push(...e.data.subarray(0, e.frames * e.channels));
    if (e.type === "take.gap") for (let i = 0; i < e.frames; i++) out.push(Number.NaN);
  }
  return out;
}

const endOf = (ev: MixerEvent[]) => {
  const e = takes(ev).find((x) => x.type === "take.end");
  if (e?.type !== "take.end") throw new Error("no take.end");
  return e;
};

describe("MixerCore open end", () => {
  it("plays an empty song until stopped, with clicks past its length", () => {
    const { m, events } = setup([], 0);
    m.setOpenEnd(true);
    m.setClickTrack(new Float64Array([0, 24_000, 96_000]), new Uint8Array([0, 1, 1]));
    m.setClick({ enabled: true });
    m.play();
    run(m, 1000); // 2.67 s
    expect(m.position.state).toBe("playing");
    expect(m.position.frame).toBe(128_000);
    expect(events.some((e) => e.type === "ended")).toBe(false);
    const report = events.filter((e) => e.type === "report").at(-1);
    expect(report?.type === "report" && report.clicks).toBe(3);
  });

  it("without open end an empty song ends at once (as before)", () => {
    const { m, events } = setup([], 0);
    m.play();
    run(m, 2);
    expect(events.some((e) => e.type === "ended")).toBe(true);
    expect(m.position.state).toBe("stopped");
  });

  it("runs past the song end, seeks beyond it and does not rewind on play", () => {
    const { m, events } = setup([track()], SR);
    m.setOpenEnd(true);
    m.seek(SR - 1280, 1 << 20);
    feed(m, SR, 1 << 20);
    m.play();
    run(m, 100);
    expect(m.position.frame).toBe(SR - 1280 + 12_800);
    expect(events.some((e) => e.type === "ended")).toBe(false);
    m.pause();
    run(m, 4);
    expect(m.position.state).toBe("stopped");
    m.seek(5 * SR, 2 << 20);
    expect(m.position.frame).toBe(5 * SR);
    m.play();
    run(m, 4);
    expect(m.position.frame).toBe(5 * SR + 512);
  });

  it("ends at the song end again once open end is off", () => {
    const { m, events } = setup([track()], SR);
    feed(m, SR);
    m.setOpenEnd(true);
    m.play();
    run(m, 400); // past 1 s
    m.setOpenEnd(false);
    run(m, 1);
    expect(events.some((e) => e.type === "ended")).toBe(true);
  });
});

describe("MixerCore capture", () => {
  it("starts with playback (no count-in) and copies the input exactly, in 4096-frame chunks", () => {
    const { m, events } = setup();
    m.setOpenEnd(true);
    m.armCapture(1, 0);
    pool(m, 8);
    m.startCapture();
    m.play();
    run(m, 100);
    m.stopCapture("user");
    const start = takes(events)[0];
    expect(start).toMatchObject({ type: "take.start", startFrame: 0, channels: 1 });
    const chunks = takes(events).filter((e) => e.type === "take.chunk");
    expect(chunks.map((c) => c.frames)).toEqual([4096, 4096, 4096, 512]);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3]);
    // Mono from a stereo input: the average (here 0).
    expect(samples(events).every((v) => v === 0)).toBe(true);
    expect(endOf(events)).toMatchObject({ frames: 12_800, startFrame: 0, endedBy: "user" });
  });

  it("starts at the sample where the count-in ends, inside a block", () => {
    const { m, events } = setup();
    m.setOpenEnd(true);
    m.armCapture(2, 0);
    pool(m, 4, 2);
    m.startCapture();
    // 4 clicks 1000.25 frames apart: the count-in ends after 4001 frames (block 31, offset 33).
    m.play({ clicks: 4, perBar: 4, intervalFrames: 1000.25 });
    run(m, 64);
    m.stopCapture("user");
    expect(takes(events)[0]).toMatchObject({ type: "take.start", startFrame: 0 });
    const s = samples(events);
    // Interleaved stereo: input frame k is (k, −k).
    expect(s.slice(0, 4)).toEqual([4001, -4001, 4002, -4002]);
    const end = endOf(events);
    expect(end.frames).toBe(64 * 128 - 4001);
    expect(s.length).toBe(end.frames * 2);
    expect(s.at(-2)).toBe(64 * 128 - 1);
  });

  it("starts at the next block when recording is started while playing", () => {
    const { m, events } = setup([track()], SR);
    feed(m, SR);
    m.setOpenEnd(true);
    m.armCapture(1, 0);
    pool(m, 4);
    m.play();
    let b = run(m, 10);
    const at = m.position.frame;
    m.startCapture();
    b = run(m, 10, b, 1);
    m.stopCapture("user");
    expect(takes(events)[0]).toMatchObject({ type: "take.start", startFrame: at });
    expect(samples(events)[0]).toBe(1280);
    expect(endOf(events).frames).toBe(1280);
    expect(b).toBe(20);
  });

  it("keeps recording past the song length", () => {
    const { m, events } = setup([track()], SR / 2);
    feed(m, SR / 2);
    m.setOpenEnd(true);
    m.armCapture(1, 0);
    pool(m, 32);
    m.startCapture();
    m.play();
    run(m, 750); // 2 s
    m.stopCapture("user");
    expect(events.some((e) => e.type === "ended")).toBe(false);
    expect(endOf(events).frames).toBe(96_000);
  });

  it("stops exactly at the maximum length, mid-block", () => {
    const { m, events } = setup();
    m.setOpenEnd(true);
    m.armCapture(1, 5000);
    pool(m, 4);
    m.startCapture();
    m.play();
    run(m, 60);
    const end = endOf(events);
    expect(end).toMatchObject({ frames: 5000, endedBy: "maxLength" });
    expect(samples(events).length).toBe(5000);
    expect(m.captureState.recording).toBe(false);
    expect(m.position.state).toBe("playing"); // the engine stops the transport
  });

  it("reports lost frames as a gap when no buffer is free, keeping the timing", () => {
    const { m, events } = setup();
    m.setOpenEnd(true);
    m.armCapture(1, 0);
    pool(m, 1);
    m.startCapture();
    m.play();
    const b = run(m, 40); // 5120 frames: one chunk, then 1024 lost
    m.addCaptureBuffer(new Float32Array(CAPTURE_CHUNK_FRAMES));
    run(m, 8, b, 1); // 1024 more, mono input = its index
    m.stopCapture("user");
    const msgs = takes(events).map((e) => e.type);
    expect(msgs).toEqual(["take.start", "take.chunk", "take.gap", "take.chunk", "take.end"]);
    const s = samples(events);
    expect(s.length).toBe(6144);
    expect(s.slice(4096, 5120).every((v) => Number.isNaN(v))).toBe(true);
    expect(s[5120]).toBe(5120);
    expect(endOf(events)).toMatchObject({ frames: 6144, gapFrames: 1024 });
  });

  it("ends a take requested during the count-in with no frames when stopped", () => {
    const { m, events } = setup();
    m.setOpenEnd(true);
    m.armCapture(1, 0);
    pool(m, 2);
    m.startCapture();
    m.play({ clicks: 4, perBar: 4, intervalFrames: 12_000 });
    run(m, 10);
    m.stopCapture("user");
    expect(endOf(events)).toMatchObject({ frames: 0, startFrame: -1, endedBy: "user" });
    expect(takes(events).some((e) => e.type === "take.start")).toBe(false);
  });

  it("ends the take when the transport jumps, stops by itself or the song reloads", () => {
    const { m, events } = setup();
    m.setOpenEnd(true);
    m.armCapture(1, 0);
    pool(m, 8);
    m.startCapture();
    m.play();
    run(m, 4);
    m.seek(48_000, 1 << 20);
    run(m, 4); // the seek lands after its fade-out
    expect(endOf(events)).toMatchObject({ frames: 640, endedBy: "transport" }); // + the fade-out block;

    events.length = 0;
    m.startCapture();
    m.play();
    run(m, 4);
    m.pause();
    run(m, 4);
    expect(endOf(events).endedBy).toBe("transport");

    events.length = 0;
    m.startCapture();
    m.play();
    run(m, 4);
    m.load([], 0);
    expect(endOf(events).endedBy).toBe("reloaded");
    expect(m.captureState.armed).toBe(true);
  });

  it("meters the input while armed and reports the take length", () => {
    const { m, events } = setup();
    m.armCapture(2, 0);
    pool(m, 8, 2);
    run(m, 19); // a report every 2400 frames, also while stopped
    let r = events.filter((e) => e.type === "report").at(-1);
    expect(r?.type === "report" && [...r.inputPeaks]).toEqual([2431, 2431]);
    m.setOpenEnd(true);
    m.startCapture();
    m.play();
    events.length = 0;
    run(m, 40, 19);
    r = events.filter((e) => e.type === "report").at(-1);
    expect(r?.type === "report" && r.recording).toBe(true);
    expect(r?.type === "report" && r.recFrames).toBeGreaterThan(0);
    m.disarmCapture();
    expect(endOf(events).endedBy).toBe("disarmed");
    events.length = 0;
    run(m, 40, 59);
    r = events.filter((e) => e.type === "report").at(-1);
    expect(r?.type === "report" && [...r.inputPeaks]).toEqual([0, 0]);
  });

  it("applies the input gain to the meter and the take", () => {
    const { m, events } = setup();
    m.setOpenEnd(true);
    m.armCapture(2, 0, 20); // ×10, from the start
    pool(m, 8, 2);
    run(m, 19);
    const r = events.filter((e) => e.type === "report").at(-1);
    expect(r?.type === "report" && [...r.inputPeaks]).toEqual([24_310, 24_310]);
    m.startCapture();
    m.play();
    events.length = 0;
    run(m, 4, 19);
    m.stopCapture("user");
    const s = samples(events);
    expect(s.slice(0, 4)).toEqual([24_320, -24_320, 24_330, -24_330]);
  });

  it("ramps a gain change across one block, then holds it", () => {
    const { m, events } = setup();
    m.setOpenEnd(true);
    m.armCapture(1, 0);
    pool(m, 8);
    m.startCapture();
    m.play();
    const in0 = new Float32Array(128).fill(0.5);
    const out = new Float32Array(128);
    const block = () => {
      m.mixBlock(out, out, 128, 0, [in0]);
    };
    block();
    m.setCaptureGain(6.020_599_913_279_624); // ×2
    block();
    block();
    m.stopCapture("user");
    const s = samples(events);
    expect(s.slice(0, 128).every((v) => v === 0.5)).toBe(true);
    const ramp = s.slice(128, 256);
    for (let i = 1; i < 128; i++) expect(ramp[i]).toBeGreaterThan(ramp[i - 1] ?? 0);
    expect(ramp[0]).toBeGreaterThan(0.5);
    expect(ramp[127]).toBeCloseTo(1, 6);
    expect(s.slice(256).every((v) => Math.abs(v - 1) < 1e-6)).toBe(true);
  });

  it("does not clip: overs stay in the float take", () => {
    const { m, events } = setup();
    m.setOpenEnd(true);
    m.armCapture(1, 0, 40);
    pool(m, 8);
    m.startCapture();
    m.play();
    const in0 = new Float32Array(128).fill(0.5);
    const out = new Float32Array(128);
    m.mixBlock(out, out, 128, 0, [in0]);
    m.stopCapture("user");
    expect(samples(events).every((v) => Math.abs(v - 50) < 1e-4)).toBe(true);
  });
});
