import { reaperFixture } from "@bandroom/fixtures";
import { beatToSec, compileTempo, parseMidiTempo, type TempoGrid } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { clickTrackFor, countInSpecAt } from "../tempo";
import {
  CLICK_SOUNDS,
  ClickVoices,
  firstAtOrAfter,
  synthClick,
  type ClickTrack,
  type CountInSpec,
} from "./click";
import { FADE_FRAMES, MixerCore, type MixerEvent, type MixerTrackConfig } from "./core";

const SR = 48_000;

function reaperGrid(): TempoGrid {
  const r = parseMidiTempo(reaperFixture().bytes);
  if (!r.ok) throw new Error(r.error);
  return compileTempo({ map: r.value.map, bar1OffsetSec: r.value.bar1OffsetSec });
}

/** Renders `frames` in 128-frame blocks (like the worklet) and returns the left channel. */
function render(m: MixerCore, frames: number): Float32Array {
  const out = new Float32Array(frames);
  const b0 = new Float32Array(128);
  const b1 = new Float32Array(128);
  for (let o = 0; o < frames; o += 128) {
    m.mixBlock(b0, b1, 128, o / SR);
    out.set(b0.subarray(0, Math.min(128, frames - o)), o);
  }
  return out;
}

/** Click onsets: a click's first sample is 0 (1 ms attack), so the onset is one frame earlier. */
function onsets(x: Float32Array, minGap = 480): { frame: number; peak: number }[] {
  const out: { frame: number; peak: number }[] = [];
  let quiet = minGap;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i] ?? 0);
    if (a > 1e-7) {
      if (quiet >= minGap) out.push({ frame: i - 1, peak: 0 });
      const last = out.at(-1);
      if (last && a > last.peak) last.peak = a;
      quiet = 0;
    } else quiet++;
  }
  return out;
}

function clickOnly(length: number, track: ClickTrack) {
  const events: MixerEvent[] = [];
  const m = new MixerCore((e) => events.push(structuredClone(e)));
  m.startFrames = 0;
  m.load([], length);
  m.setClickTrack(track.frames, track.levels);
  m.setClick({ enabled: true });
  return { m, events };
}

describe("click samples (SPEC §6.7)", () => {
  it("are 20–40 ms, start silent, accent louder than beats louder than subdivisions", () => {
    for (const sound of CLICK_SOUNDS) {
      const [a, b, c] = [synthClick(sound, 0), synthClick(sound, 1), synthClick(sound, 2)];
      for (const x of [a, b, c]) {
        expect(x.length / SR).toBeGreaterThanOrEqual(0.02);
        expect(x.length / SR).toBeLessThanOrEqual(0.04);
        expect(Math.abs(x[0] ?? 1)).toBe(0);
        expect(Math.abs(x.at(-1) ?? 1)).toBeLessThan(1e-3);
      }
      const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      expect(peak(a)).toBeGreaterThan(peak(b));
      expect(peak(b)).toBeGreaterThan(peak(c));
      expect(synthClick(sound, 1)).toEqual(b); // deterministic
    }
  });

  it("finds pulses by binary search and steals the oldest voice when all are busy", () => {
    const f = new Float64Array([10, 20, 20, 30]);
    expect([0, 10, 11, 20, 31].map((x) => firstAtOrAfter(f, x))).toEqual([0, 0, 1, 1, 4]);
    const v = new ClickVoices();
    const s = new Float32Array(10).fill(1);
    for (let i = 0; i < 9; i++) v.trigger(s, i, 1);
    const l = new Float32Array(20);
    const r = new Float32Array(20);
    expect(v.render(l, r, 20)).toBe(1);
    expect(v.count).toBe(9);
    // Voice 0 (offset 0) was stolen by the 9th: 8 voices sound at frame 9.
    expect(l[9]).toBe(8);
    expect(l[0]).toBe(0);
    expect(l[1]).toBe(1);
  });
});

describe("click in the mixer (SPEC §6.7)", () => {
  it("stays aligned with the tempo map across tempo and meter changes for the whole song", () => {
    const grid = reaperGrid();
    const f = reaperFixture();
    // Independent expectation: walk the fixture's steps beat by beat.
    const endBeat = 84;
    const expected: number[] = [];
    let t = 0;
    const segs = f.segments;
    const beatLen = (m: { num: number; den: number }) =>
      m.den >= 8 && m.num % 3 === 0 && m.num >= 6 ? 1.5 : 4 / m.den;
    let beat = 0;
    while (beat < endBeat - 1e-9) {
      expected.push(Math.round(t * SR));
      const seg = [...segs].reverse().find((s) => s.startBeat <= beat + 1e-9);
      if (!seg) throw new Error("no segment");
      const step = beatLen(seg);
      // Integrate across tempo steps inside this beat (the ramp changes every sixteenth).
      let b = beat;
      const to = beat + step;
      while (b < to - 1e-9) {
        const cur = [...segs].reverse().find((s) => s.startBeat <= b + 1e-9);
        const next = segs.find((s) => s.startBeat > b + 1e-9);
        const until = Math.min(to, next?.startBeat ?? Infinity);
        t += ((until - b) * 60) / (cur?.bpm ?? 120);
        b = until;
      }
      beat = to;
    }
    const length = Math.round(beatToSec(grid, endBeat) * SR);
    const track = clickTrackFor(grid, length, { subdivision: 1, compoundEighths: false });
    expect(track.frames.length).toBe(expected.length);
    const { m } = clickOnly(length, track);
    m.play();
    const got = onsets(render(m, length + 4800));
    expect(got.length).toBe(expected.length);
    got.forEach((o, i) => {
      expect(Math.abs(o.frame - (expected[i] ?? 0))).toBeLessThanOrEqual(1);
    });
    // Downbeats are accented: bar 1, 2 … (4/4) and bar 13 (3/4) are louder than beat 2.
    const lvl = Array.from(track.levels);
    const accent = got[lvl.indexOf(0)]?.peak ?? 0;
    const plain = got[lvl.indexOf(1)]?.peak ?? 1;
    expect(accent).toBeGreaterThan(plain * 1.2);
  });

  it("keeps clicks on the grid across a loop wrap and after a seek", () => {
    const grid = reaperGrid();
    const length = Math.round(beatToSec(grid, 84) * SR);
    const track = clickTrackFor(grid, length, { subdivision: 2, compoundEighths: false });
    const { m } = clickOnly(length, track);
    // Loop bars 13–14 (3/4 at 140 BPM): 6 beats, 12 pulses with subdivision 2.
    const start = Math.round(beatToSec(grid, 48) * SR);
    const end = Math.round(beatToSec(grid, 54) * SR);
    m.seek(start, 1 << 20);
    m.setLoop({ start, end }, 2 << 20);
    m.play();
    const lapLen = end - start;
    const got = onsets(render(m, lapLen * 3), 240).map((o) => o.frame);
    const inLoop = Array.from(track.frames).filter((x) => x >= start && x < end);
    expect(inLoop).toHaveLength(12);
    const want = [0, 1, 2].flatMap((lap) => inLoop.map((x) => x - start + lap * lapLen));
    expect(got).toHaveLength(want.length);
    got.forEach((g, i) => {
      expect(Math.abs(g - (want[i] ?? 0))).toBeLessThanOrEqual(1);
    });
  });

  it("is solo-safe by default; 'solo excludes click' and a soloed click work", () => {
    const tr: MixerTrackConfig = {
      id: "a",
      source: 1,
      channels: 1,
      clips: [],
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: true,
    };
    const m = new MixerCore(() => undefined);
    m.startFrames = 0;
    m.load([tr], SR);
    m.setClickTrack(new Float64Array([100]), new Uint8Array([0]));
    m.setClick({ enabled: true });
    m.play();
    expect(onsets(render(m, 4800))).toHaveLength(1);
    m.seek(0, 1 << 20);
    m.setClick({ soloExcludes: true });
    expect(onsets(render(m, 4800))).toHaveLength(0);
    m.seek(0, 2 << 20);
    m.setClick({ solo: true });
    expect(onsets(render(m, 4800))).toHaveLength(1);
    expect(m.clickParams.solo).toBe(true);
    m.seek(0, 3 << 20);
    m.setClick({ enabled: false });
    expect(onsets(render(m, 4800))).toHaveLength(0);
  });

  it("plays unaccented downbeats with accent off and switches sounds", () => {
    const peakOf = (accent: boolean, sound: "beep" | "hihat") => {
      const { m } = clickOnly(SR, {
        frames: new Float64Array([100]),
        levels: new Uint8Array([0]),
      });
      m.setClick({ accent, sound });
      m.play();
      return onsets(render(m, 4800))[0]?.peak ?? 0;
    };
    expect(peakOf(true, "beep")).toBeGreaterThan(peakOf(false, "beep"));
    expect(peakOf(false, "hihat")).toBeGreaterThan(0);
  });
});

describe("count-in (SPEC §6.7)", () => {
  /** A track of constant 0.25 over the whole song, so audible audio is easy to find. */
  function withAudio(length: number) {
    const events: MixerEvent[] = [];
    const m = new MixerCore((e) => events.push(structuredClone(e)));
    m.startFrames = 0;
    m.load(
      [
        {
          id: "a",
          source: 1,
          channels: 1,
          clips: [{ start: 0, end: length }],
          gainDb: 0,
          pan: 0,
          mute: false,
          solo: false,
        },
      ],
      length,
    );
    m.setClick({ gainDb: -60 }); // count-in clicks audible but tiny next to the track
    return { m, events };
  }
  function feedAll(m: MixerCore, lap: number, from: number, to: number) {
    for (let f = from; f < to; f += 4096) {
      const n = Math.min(4096, to - f);
      m.addChunk(0, 1, { lap, frame: f, length: n, data: [new Float32Array(n).fill(0.25)] });
    }
  }
  const firstLoud = (x: Float32Array, from = 0) => {
    for (let i = from; i < x.length; i++) if (Math.abs(x[i] ?? 0) > 0.01) return i;
    return -1;
  };

  it("uses the tempo and meter at the loop start and holds the playhead", () => {
    const grid = reaperGrid();
    // Bar 13 starts the 3/4 section at 140 BPM: one bar = 3 clicks of 60/140 s.
    const start = Math.round(beatToSec(grid, 48) * SR);
    const spec = countInSpecAt(grid, start, 1, false);
    expect(spec.clicks).toBe(3);
    expect(spec.perBar).toBe(3);
    expect(spec.intervalFrames).toBeCloseTo((60 / 140) * SR, 6);
    // Bar 17 is 6/8 at 90: two dotted-quarter clicks per bar (or six eighths).
    const six = Math.round(beatToSec(grid, 60) * SR);
    expect(countInSpecAt(grid, six, 2, false)).toMatchObject({ clicks: 4, perBar: 2 });
    expect(countInSpecAt(grid, six, 1, true)).toMatchObject({ clicks: 6, perBar: 6 });

    const length = Math.round(beatToSec(grid, 84) * SR);
    const { m, events } = withAudio(length);
    const lap = 1 << 20;
    m.seek(start, lap);
    feedAll(m, lap, start, start + 10 * SR);
    m.play(spec);
    const gap = Math.round(3 * spec.intervalFrames);
    const out = render(m, gap + 4800);
    // Silent track audio during the count-in, then the song fades in from the loop start.
    expect(firstLoud(out)).toBeGreaterThanOrEqual(gap);
    expect(firstLoud(out)).toBeLessThan(gap + FADE_FRAMES);
    const clicks = onsets(out.subarray(0, gap)).map((o) => o.frame);
    expect(clicks).toEqual([
      0,
      Math.round(spec.intervalFrames),
      Math.round(2 * spec.intervalFrames),
    ]);
    const first = events.find((e) => e.type === "report");
    expect(first).toMatchObject({ frame: start, preroll: gap, prerollClicks: 3 });
    // After the count-in the playhead advances from the loop start.
    const rendered = Math.ceil((gap + 4800) / 128) * 128;
    expect(m.position.frame).toBe(start + rendered - gap);
  });

  it("inserts the count-in before every repeat when asked", () => {
    const length = 20 * SR;
    const { m } = withAudio(length);
    const start = 2 * SR;
    const end = 3 * SR; // 1 s loop
    const spec: CountInSpec = { clicks: 4, perBar: 4, intervalFrames: 12_000 };
    const lap0 = 1 << 20;
    m.seek(start, lap0);
    m.setLoop({ start, end }, 2 << 20);
    const base = 2 << 20;
    for (let l = 0; l < 3; l++) feedAll(m, base + l, start, end + FADE_FRAMES);
    m.setRepeatCountIn(spec);
    m.play(); // no count-in before the first pass
    const out = render(m, SR + 48_000 + SR + 2400);
    expect(firstLoud(out)).toBeLessThan(FADE_FRAMES);
    // The lap ends at 1 s; its tail fades out within 5 ms, then 1 s of count-in.
    const gapStart = SR;
    const gapEnd = SR + 4 * 12_000;
    expect(Math.abs(out[gapStart + FADE_FRAMES + 10] ?? 1)).toBeLessThan(0.01);
    expect(firstLoud(out, gapStart + FADE_FRAMES)).toBeGreaterThanOrEqual(gapEnd);
    expect(firstLoud(out, gapStart + FADE_FRAMES)).toBeLessThan(gapEnd + FADE_FRAMES);
    // Four quiet count-in clicks in the gap.
    const gapClicks = onsets(out.subarray(gapStart + FADE_FRAMES, gapEnd)).length;
    expect(gapClicks).toBe(4);
    m.setRepeatCountIn(null);
  });

  it("plays every count-in click with a fractional interval across block boundaries", () => {
    // 255.6 frames: click 1 rounds to frame 256, the start of the third 128-frame block, while
    // 1 × 255.6 lies just before it.
    const spec: CountInSpec = { clicks: 8, perBar: 4, intervalFrames: 255.6 };
    const { m, events } = clickOnly(10 * SR, {
      frames: new Float64Array(0),
      levels: new Uint8Array(0),
    });
    m.play(spec);
    render(m, 4800);
    const last = events.filter((e) => e.type === "report").at(-1);
    expect(last).toMatchObject({ clicks: 8 });
  });

  it("stops at once when paused during the count-in; a seek cancels it", () => {
    const { m, events } = withAudio(10 * SR);
    feedAll(m, 0, 0, 10 * SR);
    m.play({ clicks: 4, perBar: 4, intervalFrames: 12_000 });
    render(m, 1280);
    m.pause();
    expect(m.position.state).toBe("stopped");
    expect(m.position.frame).toBe(0);
    m.play({ clicks: 4, perBar: 4, intervalFrames: 12_000 });
    m.play({ clicks: 2, perBar: 2, intervalFrames: 12_000 }); // while buffering: replaces it
    render(m, 1280);
    const lap = 1 << 20;
    feedAll(m, lap, SR, 10 * SR);
    m.seek(SR, lap);
    const out = render(m, 4800);
    expect(firstLoud(out)).toBeLessThan(FADE_FRAMES);
    expect(events.some((e) => e.type === "state" && e.state === "stopped")).toBe(true);
    m.play({ clicks: 0, perBar: 4, intervalFrames: 12_000 }); // invalid: ignored
  });
});
