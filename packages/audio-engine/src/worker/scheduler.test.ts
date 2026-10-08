import path from "node:path";
import { FIXTURES_DIR, generateFixtures } from "@bandroom/fixtures";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FlacCodec } from "../decode/streams";
import { createFlacCodec, createOpusCodec } from "../decode/wasm";
import { applyMixerCommand } from "../mixer/apply";
import { LAPS_PER_SEEK, MixerCore, type MixerEvent, type MixerTrackConfig } from "../mixer/core";
import { loadStretch } from "@bandroom/stretch/node";
import { mixerClips, playbackLength, workerStretch } from "../practice";
import { IngestedFixtures } from "../testing/ingested";
import type { EngineClip, EnginePractice, EngineVariant, TrackStretchPolicy } from "../types";
import type { FetchLike, FileFetcher } from "./bytes";
import { DecodeScheduler } from "./scheduler";

/**
 * Decoder worker + mixer end to end in Node: in-memory HTTP (with Range), real WASM decoders,
 * the scheduler and the mixer core. Rendering is paced by the decoder (not by a clock), so these
 * tests check sync and positioning, not speed.
 */

let fx: IngestedFixtures;
const fixture = (name: string) => path.join(FIXTURES_DIR, `${name}.wav`);
let mono48: string;
let stereo44: string;
let long44: string;

beforeAll(async () => {
  await generateFixtures();
  fx = new IngestedFixtures();
  [mono48, stereo44, long44] = await Promise.all([
    fx.ingest(fixture("imp_48000_s16_mono")),
    fx.ingest(fixture("imp_44100_s24_stereo")),
    fx.ingest(fixture("long_44100_s24_stereo")),
  ]);
}, 120_000);
afterAll(() => {
  fx.close();
});

const clip = (variant: EngineVariant, startFrame = 0): EngineClip => ({
  startFrame,
  sourceOffsetFrame: 0,
  lengthFrames:
    variant.kind === "opus"
      ? variant.totalFrames
      : Math.round((variant.totalFrames * 48_000) / variant.sampleRate),
  variant,
});

/** Output recorded per timeline position (lap, frame) → samples of channel `ch`. */
class Rig {
  events: MixerEvent[] = [];
  core = new MixerCore((e) => {
    this.events.push(structuredClone(e));
    // The worklet forwards loop changes to the decoder worker.
    if (e.type === "retime") this.sched.retime(e.fromLap, e.frame, e.base, e.loop, e.cache);
  });
  sched: DecodeScheduler;

  /** `fetch` wraps the in-memory server (to stall or fail requests). */
  constructor(
    private readonly fetch: FetchLike = fx.fetch,
    budget: { cacheBytes: number; minWholeBytes?: number } = { cacheBytes: 256 * 1024 * 1024 },
    flacCodec: () => Promise<FlacCodec> = createFlacCodec,
  ) {
    this.sched = new DecodeScheduler(
      {
        fetch: (url, init) => this.fetch(url, init),
        opusCodec: createOpusCodec,
        flacCodec,
        stretch: loadStretch,
        toMixer: (msg) => {
          applyMixerCommand(this.core, msg);
        },
        toMain: (msg) => {
          if (msg.t === "error") this.errors.push(msg.index);
        },
        yieldNow: () => new Promise((r) => setTimeout(r, 0)),
        retry: { baseMs: 10, attempts: 3 },
        ...(budget.minWholeBytes !== undefined ? { minWholeBytes: budget.minWholeBytes } : {}),
      },
      budget.cacheBytes,
      4 * 48_000,
    );
  }

  heard = new Map<number, { l: Float32Array; r: Float32Array }>(); // lap → timeline samples
  /** Tracks the decoder reported as failed. */
  errors: number[] = [];
  private length = 0;

  /** Loads tracks; with `practice`, positions are playback frames (the engine converts). */
  load(
    clips: EngineClip[][],
    practice?: EnginePractice,
    opts: { policies?: TrackStretchPolicy[]; muted?: boolean[] } = {},
  ) {
    const timeline = Math.max(...clips.flat().map((c) => c.startFrame + c.lengthFrames));
    this.length = playbackLength(timeline, practice?.rate ?? 1);
    const stretches = clips.map((cs, i) =>
      practice
        ? workerStretch(practice, opts.policies?.[i], opts.muted?.[i] ?? false, cs, timeline)
        : null,
    );
    const mixer: MixerTrackConfig[] = clips.map((cs, i) => ({
      id: `t${i}`,
      source: 1,
      channels: cs[0]?.variant.channels ?? 2,
      clips: mixerClips(cs, stretches[i], this.length),
      gainDb: 0,
      pan: 0,
      mute: opts.muted?.[i] ?? false,
      solo: false,
    }));
    this.heard.clear();
    this.sched.load(
      1,
      clips.map((cs, index) => ({ index, source: 1, clips: cs, stretch: stretches[index] })),
      this.length,
      mixer,
    );
    this.core.startFrames = 24_000;
  }

  seek(frame: number, lap: number) {
    this.sched.seek(frame, lap);
    this.core.seek(frame, lap);
  }

  /** Renders until `frames` were played (paced by the decoder), recording what was heard. */
  async play(frames: number, timeoutMs = 60_000) {
    this.core.play();
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    const deadline = Date.now() + timeoutMs;
    let played = 0;
    while (played < frames) {
      if (Date.now() > deadline) throw new Error(`timeout after ${played} frames`);
      const pos = this.core.position;
      if (pos.state === "stopped") break;
      // Producers stop short of a full window; near the end every remaining frame is needed.
      const need = Math.min(this.sched.windowFrames - 2048, this.length - pos.frame);
      const ahead = this.sched.ahead().filter((_, i) => !this.errors.includes(i));
      if (pos.state === "playing" && Math.min(...ahead) < need) {
        await new Promise((res) => setTimeout(res, 1));
        continue;
      }
      if (pos.state === "buffering") await new Promise((res) => setTimeout(res, 1));
      this.core.mixBlock(l, r, 128, 0);
      const after = this.core.position;
      if (pos.state === "playing" && after.lap === pos.lap) {
        let buf = this.heard.get(pos.lap);
        if (!buf) {
          buf = { l: new Float32Array(this.length), r: new Float32Array(this.length) };
          this.heard.set(pos.lap, buf);
        }
        const n = Math.min(128, after.frame - pos.frame);
        buf.l.set(l.subarray(0, n), pos.frame);
        buf.r.set(r.subarray(0, n), pos.frame);
        played += n;
      }
      this.sched.position(after.frame, after.lap);
    }
  }

  peak(lap: number, ch: "l" | "r", around: number, window = 300): number {
    const buf = this.heard.get(lap)?.[ch];
    if (!buf) return -1;
    let best = -1;
    let bestAbs = -1;
    for (let i = around - window; i < around + window; i++) {
      const a = Math.abs(buf[i] ?? 0);
      if (a > bestAbs) {
        bestAbs = a;
        best = i;
      }
    }
    return best;
  }

  get underruns() {
    return this.events.flatMap((e) =>
      e.type === "report" ? [...e.underruns].filter((frames) => frames > 0) : [],
    );
  }

  dispose() {
    this.sched.dispose();
  }
}

describe("decoder worker + mixer", () => {
  it(
    "plays Opus and resampled FLAC tracks sample-aligned with a clip offset",
    { timeout: 120_000 },
    async () => {
      const rig = new Rig();
      const a = await fx.variant(mono48, "opus"); // mono: left gain cos(π/4)
      const b = await fx.variant(stereo44, "flac"); // 44.1 kHz → resampled
      rig.load([[clip(a)], [clip(b, 1000)]]);
      await rig.play(7 * 48_000); // to the end
      for (const s of [0.5, 3, 5.5]) {
        const f = Math.round(s * 48_000);
        expect(Math.abs(rig.peak(0, "l", f) - f), `opus ${s}s`).toBeLessThanOrEqual(1);
        expect(
          Math.abs(rig.peak(0, "r", f + 1000, 200) - (f + 1000)),
          `flac ${s}s`,
        ).toBeLessThanOrEqual(1);
      }
      expect(rig.events.some((e) => e.type === "ended")).toBe(true);
      expect(rig.underruns).toEqual([]);
      rig.dispose();
    },
  );

  it("seeks near the end right after loading", { timeout: 120_000 }, async () => {
    const rig = new Rig();
    const v = await fx.variant(long44, "opus");
    rig.load([[clip(v)]]);
    const target = 60 * 48_000 - 24_000;
    rig.seek(target, LAPS_PER_SEEK);
    await rig.play(48_000);
    expect(Math.abs(rig.peak(LAPS_PER_SEEK, "l", 60 * 48_000) - 60 * 48_000)).toBeLessThanOrEqual(
      1,
    );
    rig.dispose();
  });

  it("drops mixer messages about an earlier song load", async () => {
    const rig = new Rig();
    const v = await fx.variant(mono48, "opus");
    rig.load([[clip(v)]]); // load id 1
    const position = vi.spyOn(rig.sched, "position");
    const seek = vi.spyOn(rig.sched, "seek");
    const retime = vi.spyOn(rig.sched, "retime");
    // In flight from the song before (load 0): applied, a late playhead report would move the
    // new song's decoding to the old position while the mixer waits at the start (WebKit).
    rig.sched.fromMixer({ t: "pos", load: 0, frame: 4 * 48_000, lap: 0 });
    rig.sched.fromMixer({ t: "seek", load: 0, frame: 4 * 48_000, lap: LAPS_PER_SEEK });
    const retimeMsg = { load: 0, fromLap: 0, frame: 0, base: 0, loop: null, cache: false };
    rig.sched.fromMixer({ t: "retime", ...retimeMsg });
    expect(position).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
    expect(retime).not.toHaveBeenCalled();
    rig.sched.fromMixer({ t: "pos", load: 1, frame: 100, lap: 0 });
    rig.sched.fromMixer({ t: "seek", load: 1, frame: 200, lap: LAPS_PER_SEEK });
    rig.sched.fromMixer({ t: "retime", ...retimeMsg, load: 1 });
    expect(position).toHaveBeenCalledWith(100, 0);
    expect(seek).toHaveBeenCalledWith(200, LAPS_PER_SEEK);
    expect(retime).toHaveBeenCalledTimes(1);
    rig.dispose();
  });

  it(
    "plays a song again after switching to another song mid-download",
    { timeout: 120_000 },
    async () => {
      // A's first downloads deliver 4 KB and then hang, so they are still running at the switch.
      let stall = true;
      let stalled = 0;
      const stalling: FetchLike = async (url, init) => {
        const res = await fx.fetch(url, init);
        if (!stall || !res.body) return res;
        const inner = res.body.getReader();
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull: async (ctrl) => {
            if (sent >= 4096) {
              stalled++;
              await new Promise((r) => init.signal?.addEventListener("abort", r));
              ctrl.error(new Error("aborted"));
              return;
            }
            const { done, value } = await inner.read();
            if (done) {
              ctrl.close();
              return;
            }
            const piece = value.subarray(0, 4096 - sent);
            sent += piece.length;
            ctrl.enqueue(piece);
          },
        });
        return { ...res, body };
      };
      const rig = new Rig(stalling);
      const a = [
        [clip(await fx.variant(long44, "flac"))],
        [clip(await fx.variant(long44, "opus"))],
      ];
      const b = [[clip(await fx.variant(mono48, "opus"))]];
      rig.load(a);
      const started = Date.now();
      while (stalled < 2) {
        if (Date.now() - started > 10_000) throw new Error("no stalled download");
        await new Promise((r) => setTimeout(r, 5));
      }
      rig.load(b); // stops A's downloads half-way
      stall = false;
      rig.load(a);
      await rig.play(48_000, 30_000);
      expect(rig.core.position.frame).toBeGreaterThanOrEqual(48_000);
      rig.dispose();
    },
  );

  it("recovers from transient server errors", { timeout: 120_000 }, async () => {
    const a = await fx.variant(mono48, "opus");
    const b = await fx.variant(stereo44, "flac");
    const failures = new Map<string, number>();
    // Every file answers 503 twice before it works.
    const rig = new Rig((url, init) => {
      const n = failures.get(url) ?? 0;
      failures.set(url, n + 1);
      if (n < 2) return Promise.resolve({ status: 503, headers: { get: () => null }, body: null });
      return fx.fetch(url, init);
    });
    rig.load([[clip(a)], [clip(b, 1000)]]);
    await rig.play(7 * 48_000);
    expect(rig.events.some((e) => e.type === "ended")).toBe(true);
    expect(rig.errors).toEqual([]);
    expect(Math.abs(rig.peak(0, "r", 145_000, 200) - 145_000)).toBeLessThanOrEqual(1);
    rig.dispose();
  });

  it(
    "fetches a seek index again after a failure or an invalid file",
    { timeout: 120_000 },
    async () => {
      const v = await fx.variant(long44, "opus");
      const indexUrl = v.seekIndexUrl ?? "";
      expect(indexUrl).not.toBe("");
      let requests = 0;
      const rig = new Rig((url, init) => {
        if (url !== indexUrl) return fx.fetch(url, init);
        requests++;
        if (requests === 1) return Promise.reject(new TypeError("Failed to fetch"));
        if (requests === 2) {
          const body = new Response('[[0,1],"x"]').body;
          return Promise.resolve({ status: 200, headers: { get: () => null }, body });
        }
        return fx.fetch(url, init);
      });
      rig.load([[clip(v)]]);
      const impulse = 60 * 48_000;
      // Without an index the seek still lands right (decoding from the start).
      rig.seek(impulse - 48_000, LAPS_PER_SEEK);
      await rig.play(48_000);
      expect(Math.abs(rig.peak(LAPS_PER_SEEK, "l", impulse) - impulse)).toBeLessThanOrEqual(1);
      rig.seek(impulse - 96_000, 2 * LAPS_PER_SEEK);
      await rig.play(24_000);
      rig.seek(impulse - 72_000, 3 * LAPS_PER_SEEK);
      await rig.play(24_000);
      // The network error and the invalid file were not cached; the valid index is.
      expect(requests).toBe(3);
      rig.seek(impulse - 24_000, 4 * LAPS_PER_SEEK);
      await rig.play(30_000);
      expect(requests).toBe(3);
      expect(Math.abs(rig.peak(4 * LAPS_PER_SEEK, "l", impulse) - impulse)).toBeLessThanOrEqual(1);
      rig.dispose();
    },
  );

  it(
    "reads Opus files bigger than their share of the budget in windows",
    { timeout: 120_000 },
    async () => {
      const a = await fx.variant(long44, "opus");
      const b = await fx.variant(mono48, "opus");
      const rig = new Rig(fx.fetch, { cacheBytes: 2 * 16 * 1024, minWholeBytes: 0 });
      rig.load([[clip(a)], [clip(b)]]);
      const impulse = 60 * 48_000;
      rig.seek(impulse - 24_000, LAPS_PER_SEEK);
      await rig.play(30_000);
      expect(Math.abs(rig.peak(LAPS_PER_SEEK, "l", impulse) - impulse)).toBeLessThanOrEqual(1);
      const files = (rig.sched as unknown as { files: Map<string, { fetcher: FileFetcher }> })
        .files;
      expect(files.get(a.hash)?.fetcher.mode).toBe("window"); // 44 kB, more than its 16 kB share
      expect(rig.errors).toEqual([]);
      rig.dispose();
    },
  );

  it("plays the other tracks when a file is missing", { timeout: 120_000 }, async () => {
    const a = await fx.variant(mono48, "opus");
    const b = await fx.variant(stereo44, "flac");
    const rig = new Rig((url, init) =>
      url === b.url
        ? Promise.resolve({ status: 404, headers: { get: () => null }, body: null })
        : fx.fetch(url, init),
    );
    rig.load([[clip(a)], [clip(b, 1000)]]);
    // The failed track neither blocks the start nor counts as an underrun.
    await rig.play(7 * 48_000);
    expect(rig.events.some((e) => e.type === "ended")).toBe(true);
    expect(rig.errors).toEqual([1]);
    expect(rig.underruns).toEqual([]);
    rig.dispose();
  });

  it(
    "keeps audio decoded while a seek lands on the decoder's position",
    {
      timeout: 120_000,
    },
    async () => {
      // While a FLAC block decodes (async), a seek lands exactly where the decoder is: its cursor
      // stays valid, so the decoded block must not be dropped.
      let onDecode: (() => void) | null = null;
      const flacCodec = async (): Promise<FlacCodec> => {
        const inner = await createFlacCodec();
        return {
          decodeFrames: async (frames) => {
            const out = await inner.decodeFrames(frames);
            const hook = onDecode;
            hook?.();
            return out;
          },
          free: () => {
            inner.free();
          },
        };
      };
      const rig = new Rig(fx.fetch, undefined, flacCodec);
      const v = await fx.variant(long44, "flac");
      rig.load([[clip(v)]]);
      const impulse = 60 * 48_000;
      const start = impulse - 30 * 48_000; // one FLAC push of near silence decodes ~10 s
      rig.seek(start, LAPS_PER_SEEK);
      const producer = (rig.sched as unknown as { producers: { frame: number }[] }).producers[0];
      let at = -1;
      onDecode = () => {
        const f = producer?.frame ?? 0;
        if (f <= start) return;
        onDecode = null;
        at = f;
        rig.seek(f, 2 * LAPS_PER_SEEK);
      };
      await rig.play(impulse + 24_000 - start, 30_000);
      expect(at).toBeGreaterThan(start);
      expect(at).toBeLessThan(impulse);
      expect(Math.abs(rig.peak(2 * LAPS_PER_SEEK, "l", impulse) - impulse)).toBeLessThanOrEqual(1);
      expect(rig.underruns).toEqual([]);
      rig.dispose();
    },
  );

  it("switches quality mid-song without losing sync", { timeout: 120_000 }, async () => {
    const rig = new Rig();
    const opus = await fx.variant(stereo44, "opus");
    const flac = await fx.variant(stereo44, "flac");
    rig.load([[clip(opus)]]);
    await rig.play(48_000);
    rig.sched.setSource(0, 2, [clip(flac)]);
    await rig.play(4 * 48_000);
    expect(Math.abs(rig.peak(0, "l", 144_000) - 144_000)).toBeLessThanOrEqual(1);
    expect(rig.underruns).toEqual([]);
    rig.dispose();
  });

  it("loops lap after lap with the impulse at the same frame", { timeout: 120_000 }, async () => {
    const rig = new Rig();
    const v = await fx.variant(mono48, "opus");
    rig.load([[clip(v)]]);
    const loop = { start: 100_000, end: 160_000 };
    rig.core.setLoop(loop, LAPS_PER_SEEK);
    const B = 2 * LAPS_PER_SEEK;
    rig.seek(90_000, B);
    await rig.play(10_000 + 3 * 60_000);
    for (const lap of [B, B + 1, B + 2]) {
      expect(Math.abs(rig.peak(lap, "l", 144_000) - 144_000), `lap ${lap}`).toBeLessThanOrEqual(1);
    }
    expect(rig.underruns).toEqual([]);
    rig.dispose();
  });

  it(
    "plays loop repeats from the loop cache after one decoded lap",
    { timeout: 120_000 },
    async () => {
      const rig = new Rig();
      const a = await fx.variant(mono48, "opus");
      const b = await fx.variant(stereo44, "flac");
      rig.load([[clip(a)], [clip(b, 1000)]]);
      const loop = { start: 120_000, end: 170_000 };
      rig.core.setLoop(loop, LAPS_PER_SEEK, true);
      const B = 2 * LAPS_PER_SEEK;
      rig.seek(loop.start, B);
      await rig.play(5 * 50_000);
      expect(rig.core.loopCache.complete).toEqual([true, true]);
      // The decoder stopped: nothing is produced beyond the first lap.
      expect(rig.sched.ahead()).toEqual([rig.sched.windowFrames, rig.sched.windowFrames]);
      for (const lap of [B, B + 1, B + 3, B + 4]) {
        expect(Math.abs(rig.peak(lap, "l", 144_000) - 144_000), `opus ${lap}`).toBeLessThanOrEqual(
          1,
        );
        expect(Math.abs(rig.peak(lap, "r", 145_000, 200) - 145_000), `flac ${lap}`).toBe(0);
      }
      expect(rig.underruns).toEqual([]);
      rig.dispose();
    },
  );

  it("sets and moves a loop while playing, keeping sync", { timeout: 120_000 }, async () => {
    const rig = new Rig();
    const v = await fx.variant(mono48, "opus");
    rig.load([[clip(v)]]);
    rig.seek(120_000, LAPS_PER_SEEK);
    await rig.play(12_000);
    const buffering = () =>
      rig.events.filter((e) => e.type === "state" && e.state === "buffering").length;
    const n = buffering();
    rig.core.setLoop({ start: 110_000, end: 150_000 }, 2 * LAPS_PER_SEEK, true);
    await rig.play(30_000 + 40_000);
    // Moving the loop end past the data decoded so far, then clearing it.
    rig.core.setLoop({ start: 130_000, end: 200_000 }, 3 * LAPS_PER_SEEK, false);
    await rig.play(30_000); // 122 000 → 152 000, over the impulse
    rig.core.setLoop(null, 4 * LAPS_PER_SEEK);
    await rig.play(48_000);
    expect(buffering()).toBe(n); // never rebuffered
    expect(rig.underruns).toEqual([]);
    // The impulse at 3 s (144 000) sits at the same frame on the laps that played it.
    for (const lap of [2 * LAPS_PER_SEEK, 2 * LAPS_PER_SEEK + 1, 3 * LAPS_PER_SEEK]) {
      expect(Math.abs(rig.peak(lap, "l", 144_000) - 144_000), `lap ${lap}`).toBeLessThanOrEqual(1);
    }
    rig.dispose();
  });
});

describe("decoder worker + mixer with practice speed and pitch (SPEC §30.5)", () => {
  const T = [24_000, 144_000, 264_000]; // impulses of imp_48000 (0.5, 3, 5.5 s)

  it.each([0.5, 0.75, 1.5])(
    "plays Opus and resampled FLAC at %s× with the impulses at t / rate, mutually aligned",
    { timeout: 180_000 },
    async (rate) => {
      // One track per rig: in a shared mix the other track's impulse can be the louder peak.
      const at = async (variant: EngineVariant, offset: number, ch: "l" | "r") => {
        const rig = new Rig();
        rig.load([[clip(variant, offset)]], { rate, semitones: 0, quality: "high" });
        await rig.play(Math.floor((6 * 48_000 + offset) / rate));
        expect(rig.underruns).toEqual([]);
        const peaks = T.map((t) => rig.peak(0, ch, Math.round((t + offset) / rate), 1500));
        rig.dispose();
        return peaks;
      };
      const a = await fx.variant(mono48, "opus");
      const b = await fx.variant(stereo44, "flac");
      const pa = await at(a, 0, "l");
      const pb = await at(b, 1000, "r");
      const pa2 = await at(a, 1000, "l");
      T.forEach((t, i) => {
        const want = Math.round(t / rate);
        expect(Math.abs((pa[i] ?? 0) - want), `opus ${t}`).toBeLessThan(400);
        expect(Math.abs((pb[i] ?? 0) - want - 1000 / rate), `flac ${t}`).toBeLessThan(400);
        // Same content, same configuration: shifting a clip shifts its output by offset / rate.
        expect(Math.abs((pa2[i] ?? 0) - (pa[i] ?? 0) - 1000 / rate), `sync ${t}`).toBeLessThan(16);
      });
    },
  );

  it("transposes without moving the impulses at 100 %", { timeout: 180_000 }, async () => {
    const rig = new Rig();
    const a = await fx.variant(mono48, "opus");
    rig.load([[clip(a)]], { rate: 1, semitones: -3, quality: "economy" });
    await rig.play(6 * 48_000);
    for (const t of T) expect(Math.abs(rig.peak(0, "l", t, 1500) - t)).toBeLessThan(400);
    expect(rig.underruns).toEqual([]);
    rig.dispose();
  });

  it("keeps a track that is not transposed bit-identical at 100 %", async () => {
    const plain = new Rig();
    const practice = new Rig();
    const a = await fx.variant(mono48, "opus");
    plain.load([[clip(a)]]);
    const drums: TrackStretchPolicy = {
      transpose: false,
      profile: "percussive",
      voiceBaseHz: 0,
      formant: false,
      formantShift: 0,
    };
    practice.load([[clip(a)]], { rate: 1, semitones: 2, quality: "high" }, { policies: [drums] });
    await plain.play(3 * 48_000);
    await practice.play(3 * 48_000);
    expect(practice.heard.get(0)?.l).toEqual(plain.heard.get(0)?.l);
    plain.dispose();
    practice.dispose();
  });

  it("plays a formant shift alone at 100 % with the impulses in place", async () => {
    const rig = new Rig();
    const a = await fx.variant(mono48, "opus");
    const voice: TrackStretchPolicy = {
      transpose: true,
      profile: "voice",
      voiceBaseHz: 0,
      formant: true,
      formantShift: 4,
    };
    rig.load([[clip(a)]], { rate: 1, semitones: 0, quality: "high" }, { policies: [voice] });
    expect(rig.sched.ahead()).toHaveLength(1);
    await rig.play(6 * 48_000);
    for (const t of T) expect(Math.abs(rig.peak(0, "l", t, 1500) - t)).toBeLessThan(400);
    expect(rig.underruns).toEqual([]);
    rig.dispose();
  });

  it("seeks at 75 % to the stretched position", { timeout: 180_000 }, async () => {
    const rig = new Rig();
    const a = await fx.variant(mono48, "opus");
    rig.load([[clip(a)]], { rate: 0.75, semitones: 0, quality: "high" });
    const p = Math.round(120_000 / 0.75);
    rig.seek(p, LAPS_PER_SEEK);
    await rig.play(96_000);
    const want = Math.round(144_000 / 0.75);
    expect(Math.abs(rig.peak(LAPS_PER_SEEK, "l", want, 1500) - want)).toBeLessThan(400);
    expect(rig.underruns).toEqual([]);
    rig.dispose();
  });

  it.each([false, true])(
    "loops at 50 % with the impulse on the same frame every lap (cache %s)",
    { timeout: 240_000 },
    async (cache) => {
      const rig = new Rig();
      const a = await fx.variant(mono48, "opus");
      rig.load([[clip(a)]], { rate: 0.5, semitones: -1, quality: "high" });
      const loop = { start: 200_000, end: 320_000 }; // 100 000…160 000 on the timeline
      rig.core.setLoop(loop, LAPS_PER_SEEK, cache);
      const B = 2 * LAPS_PER_SEEK;
      rig.seek(loop.start, B);
      await rig.play(3 * 120_000);
      const first = rig.peak(B, "l", 288_000, 1500);
      expect(Math.abs(first - 288_000)).toBeLessThan(400);
      for (const lap of [B + 1, B + 2]) {
        expect(Math.abs(rig.peak(lap, "l", 288_000, 1500) - first), `lap ${lap}`).toBeLessThan(2);
      }
      if (cache) expect(rig.core.loopCache.complete).toEqual([true]);
      expect(rig.underruns).toEqual([]);
      rig.dispose();
    },
  );

  it("plays a muted track as silence and switches it back in when unmuted", async () => {
    const rig = new Rig();
    const a = await fx.variant(mono48, "opus");
    const practice: EnginePractice = { rate: 0.75, semitones: 0, quality: "high" };
    rig.load([[clip(a)]], practice, { muted: [true] });
    await rig.play(48_000);
    expect(rig.sched.ahead()[0]).toBeGreaterThan(0);
    // Unmuted: the engine switches the source (a stretched producer) after the switch lead.
    const stretch = workerStretch(practice, undefined, false, [clip(a)], 6 * 48_000);
    rig.sched.setSource(0, 2, [clip(a)], 0, 0, stretch);
    applyMixerCommand(rig.core, { t: "track", index: 0, params: { mute: false } });
    await rig.play(4 * 48_000);
    const want = Math.round(144_000 / 0.75);
    expect(Math.abs(rig.peak(0, "l", want, 1500) - want)).toBeLessThan(400);
    expect(rig.underruns).toEqual([]);
    rig.dispose();
  });
});
