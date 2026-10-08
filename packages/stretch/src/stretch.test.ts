import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createStretch, type StretchSpec } from "./create";
import { StretchModule } from "./module";
import { loadStretch } from "./node";
import { stretchSettings } from "./profiles";
import { StretchStream } from "./stream";

const SR = 48_000;

function spec(over: Partial<StretchSpec> = {}): StretchSpec {
  return {
    channels: 1,
    rate: 1,
    semitones: 0,
    profile: "tonal",
    quality: "high",
    voiceBaseHz: 0,
    ...over,
  };
}

function run(s: StretchStream, input: Float32Array, start: number, chunk = 4096): Float32Array {
  const pre = Math.min(s.preroll, start);
  s.begin(pre);
  const parts: Float32Array[] = [];
  for (let p = start - pre; p < input.length; p += chunk) {
    parts.push(first(s.push([input], p, Math.min(chunk, input.length - p))));
  }
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function first(x: Float32Array[]): Float32Array {
  const [c0] = x;
  if (!c0) throw new Error("no channels");
  return c0;
}

function impulseAt(length: number, at: number): Float32Array {
  const x = new Float32Array(length);
  for (let i = 0; i < 64; i++) x[at + i] = Math.sin((i / 64) * Math.PI) * (i % 2 ? 1 : -1);
  return x;
}

function peakIndex(x: Float32Array): number {
  let best = 0;
  let at = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i] ?? 0);
    if (v > best) {
      best = v;
      at = i;
    }
  }
  return at;
}

/** Frequency from interpolated rising zero crossings. */
function frequency(x: Float32Array, from: number, to: number): number {
  const crossings: number[] = [];
  for (let i = from + 1; i < to; i++) {
    const a = x[i - 1] ?? 0;
    const b = x[i] ?? 0;
    if (a < 0 && b >= 0) crossings.push(i - 1 + a / (a - b));
  }
  const from0 = crossings[0] ?? 0;
  const last = crossings[crossings.length - 1] ?? 0;
  return ((crossings.length - 1) * SR) / (last - from0);
}

describe("stretch.wasm", () => {
  it("instantiates from bytes and from a compiled module", async () => {
    const bytes = await readFile(new URL("./stretch.wasm", import.meta.url));
    const a = await StretchModule.instantiate(bytes);
    const b = await StretchModule.instantiate(await WebAssembly.compile(bytes));
    const input = impulseAt(SR * 2, SR);
    const outA = run(createStretch(a, spec({ semitones: -3 })), input, SR / 2);
    const outB = run(createStretch(b, spec({ semitones: -3 })), input, SR / 2);
    expect(outA).toEqual(outB);
  });

  it("reports the configured block, interval and latencies", async () => {
    const mod = await loadStretch();
    const set = stretchSettings("tonal", "high");
    const s = mod.create({ channels: 2, ...set, maxIn: 16_384, maxOut: 16_384 });
    expect(s.blockSamples).toBe(5760);
    expect(s.intervalSamples).toBe(1440);
    expect(s.seekLength).toBe(7200);
    expect(s.inputLatency).toBeGreaterThan(0);
    expect(s.outputLatency).toBeGreaterThan(0);
    expect(s.input(1)).toHaveLength(16_384);
    expect(s.output(0)).toHaveLength(16_384);
    s.dispose();
    s.dispose();
    expect(() => {
      s.process(1, 1);
    }).toThrow(/disposed/);
  });

  it("refuses frame counts beyond the buffers", async () => {
    const mod = await loadStretch();
    const s = mod.create({
      channels: 1,
      ...stretchSettings("mix", "economy"),
      maxIn: 100,
      maxOut: 50,
    });
    expect(() => {
      s.process(101, 10);
    }).toThrow(RangeError);
    expect(() => {
      s.process(10, 51);
    }).toThrow(RangeError);
    expect(() => {
      s.flush(-1);
    }).toThrow(RangeError);
    expect(() => {
      s.seek(1.5, 1);
    }).toThrow(RangeError);
    s.flush(10);
    s.reset();
    s.dispose();
  });

  it.each([0.25, 0.5, 0.75, 1, 1.5, 2])(
    "places an impulse at t on t / rate (rate %s)",
    async (rate) => {
      const mod = await loadStretch();
      const start = SR * 2;
      const at = SR * 3;
      const s = createStretch(mod, spec({ rate, profile: "percussive" }));
      const out = run(s, impulseAt(SR * 6, at), start);
      const want = (at + 32 - start) / rate;
      // Within one interval (SPEC §30.8); in practice a few frames except at extreme stretch.
      expect(Math.abs(peakIndex(out) - want)).toBeLessThan(rate < 0.5 ? 1440 : 360);
      s.dispose();
    },
  );

  it("starts at the beginning of a song without pre-roll", async () => {
    const mod = await loadStretch();
    const s = createStretch(mod, spec({ semitones: 2 }));
    const out = run(s, impulseAt(SR * 3, SR), 0);
    expect(Math.abs(peakIndex(out) - (SR + 32))).toBeLessThan(360);
    s.dispose();
  });

  it("never drifts: output = floor(input / rate), whatever the chunking", async () => {
    const mod = await loadStretch();
    const rate = 0.75;
    const s = createStretch(mod, spec({ rate }));
    const input = new Float32Array(SR * 4);
    s.begin(0);
    let total = 0;
    let p = 0;
    const sizes = [1, 333, 4096, 17, 9999, 20000];
    for (let i = 0; p < input.length; i++) {
      const n = Math.min(sizes[i % sizes.length] ?? 1, input.length - p);
      total += first(s.push([input], p, n)).length;
      p += n;
    }
    const lat = latencies();
    const held = lat.input;
    const afterStart = input.length - held;
    expect(total).toBe(Math.floor(afterStart / rate) - lat.output);
    s.dispose();

    function latencies() {
      const t = mod.create({
        channels: 1,
        ...stretchSettings("tonal", "high"),
        maxIn: 8,
        maxOut: 8,
      });
      const r = { input: t.inputLatency, output: t.outputLatency };
      t.dispose();
      return r;
    }
  });

  it("gives the same samples for any chunking and for separate instances", async () => {
    const mod = await loadStretch();
    const input = new Float32Array(SR * 3);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 330 * i) / SR) * 0.5;
    const a = run(createStretch(mod, spec({ rate: 0.8, semitones: -1 })), input, SR, 4096);
    const b = run(createStretch(mod, spec({ rate: 0.8, semitones: -1 })), input, SR, 1000);
    expect(b.length).toBe(a.length);
    expect(b).toEqual(a);
  });

  // Signalsmith predicts phases from interpolated neighbouring bins, which leaves low partials a
  // few cents sharp (≈ +3.5 ct at 440 Hz, up to ≈ +15 ct for the fundamental of a 110 Hz tone
  // with the default block; the same in a native build). 1 kHz is exact. SPEC §30.8.
  it.each([
    [1000, -2, 2],
    [1000, 3, 2],
    [1000, -12, 2],
    [1000, 0.37, 2],
    [440, -2, 5],
    [440, 3, 5],
  ] as const)(
    "transposes a %s Hz sine by %s semitones within ±%s cents",
    async (f0, semitones, tol) => {
      const mod = await loadStretch();
      const input = new Float32Array(SR * 4);
      for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * f0 * i) / SR) * 0.5;
      const out = run(createStretch(mod, spec({ semitones })), input, SR);
      const f = frequency(out, SR / 2, SR * 2);
      const cents = 1200 * Math.log2(f / f0) - semitones * 100;
      expect(Math.abs(cents)).toBeLessThan(tol);
    },
  );

  it("keeps the pitch while stretching", async () => {
    const mod = await loadStretch();
    const input = new Float32Array(SR * 4);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.5;
    const out = run(createStretch(mod, spec({ rate: 0.6 })), input, SR);
    const f = frequency(out, SR, SR * 3);
    expect(Math.abs(1200 * Math.log2(f / 1000))).toBeLessThan(2);
  });

  it("feeds stereo from mono input by repeating the last channel", async () => {
    const mod = await loadStretch();
    const s = createStretch(mod, spec({ channels: 2, semitones: 1 }));
    const out = run(s, impulseAt(SR * 2, SR), SR / 2);
    expect(out.length).toBeGreaterThan(0);
    s.dispose();
  });

  it("validates the rate and the pre-roll", async () => {
    const mod = await loadStretch();
    const t = mod.create({
      channels: 1,
      ...stretchSettings("tonal", "high"),
      maxIn: 100,
      maxOut: 100,
    });
    expect(() => new StretchStream(t, 0)).toThrow(RangeError);
    expect(() => new StretchStream(t, 1)).toThrow(/pre-roll/);
    t.dispose();
  });
});

describe("formants", () => {
  /** Magnitude of a DFT bin at `f` Hz over `len` frames from `from` (Hann window). */
  function magnitude(x: Float32Array, from: number, len: number, f: number): number {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * f) / SR;
    for (let i = 0; i < len; i++) {
      const v = (x[from + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len));
      re += v * Math.cos(w * i);
      im -= v * Math.sin(w * i);
    }
    return Math.hypot(re, im);
  }

  /** Energy-weighted mean harmonic number of a 220 Hz tone. */
  function centroid(x: Float32Array): number {
    let num = 0;
    let den = 0;
    for (let k = 1; k <= 30; k++) {
      const m = magnitude(x, SR, SR / 2, 220 * k) ** 2;
      num += k * m;
      den += m;
    }
    return num / den;
  }

  it("shifts the formants up without moving the pitch", async () => {
    const mod = await loadStretch();
    const input = new Float32Array(SR * 3);
    for (let i = 0; i < input.length; i++) {
      let v = 0;
      for (let k = 1; k <= 30; k++) v += Math.sin((2 * Math.PI * 220 * k * i) / SR) / k;
      input[i] = 0.2 * v;
    }
    const plain = run(createStretch(mod, spec({ semitones: 0.0001 })), input, SR / 2);
    const brighter = run(
      createStretch(mod, spec({ semitones: 0.0001, formant: true, formantSemitones: 6 })),
      input,
      SR / 2,
    );
    expect(centroid(brighter)).toBeGreaterThan(centroid(plain) * 1.15);
    // The fundamental stays at 220 Hz: its bin dominates the neighbouring quarter tones.
    const f0 = magnitude(brighter, SR, SR / 2, 220);
    expect(f0).toBeGreaterThan(3 * magnitude(brighter, SR, SR / 2, 220 * 2 ** (1 / 24)));
  });
});

describe("stretchSettings", () => {
  it("uses the default preset, a short block for drums and formants for voices", () => {
    expect(stretchSettings("tonal", "high")).toEqual({
      blockSamples: 5760,
      intervalSamples: 1440,
      splitComputation: false,
      tonalityHz: 8000,
      formant: false,
    });
    expect(stretchSettings("percussive", "high").blockSamples).toBe(2880);
    expect(stretchSettings("voice", "economy")).toMatchObject({
      blockSamples: 4800,
      intervalSamples: 1920,
      formant: true,
    });
  });
});
