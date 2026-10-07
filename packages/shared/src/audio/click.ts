/**
 * Click sounds (SPEC §6.7): short samples synthesized in code (no files), with an accented
 * downbeat (higher pitch, louder) and a softer subdivision. Deterministic, so tests can find every
 * click onset. Shared by the browser engine (worklet) and the server's bounce (SPEC §5.5), so a
 * bounced click is the click the Player plays, sample for sample. Allocation happens only in
 * {@link synthClick}; nothing here may import zod (the worklet bundles this module).
 */

const SAMPLE_RATE = 48_000;

export const CLICK_SOUNDS = ["woodblock", "beep", "hihat"] as const;
export type ClickSound = (typeof CLICK_SOUNDS)[number];

/** 0 = accented downbeat, 1 = beat, 2 = subdivision. */
export type ClickLevel = 0 | 1 | 2;

const LEVEL_GAIN = [1, 0.7, 0.4] as const;

/** Deterministic noise (xorshift32) for the hi-hat. */
function noise(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x80000000 - 1;
  };
}

/** One click sample at 48 kHz: 20–40 ms, starting at its first sample (the onset). */
export function synthClick(sound: ClickSound, level: ClickLevel): Float32Array {
  const accent = level === 0;
  const gain = LEVEL_GAIN[level];
  const ms = sound === "beep" ? 40 : sound === "hihat" ? 25 : 30;
  const n = Math.round((ms / 1000) * SAMPLE_RATE);
  const out = new Float32Array(n);
  const attack = 48; // 1 ms
  const release = 240; // 5 ms fade at the end: no click from the click
  if (sound === "hihat") {
    const rnd = noise(accent ? 7 : 3);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const w = rnd();
      const hp = w - prev; // crude high-pass: brighter noise
      prev = w;
      const env = Math.exp(-i / (SAMPLE_RATE * (accent ? 0.012 : 0.008)));
      out[i] = 0.5 * hp * env;
    }
  } else {
    const f = sound === "beep" ? (accent ? 1760 : 880) : accent ? 1600 : 1100;
    const tau = sound === "beep" ? 0.02 : 0.006;
    for (let i = 0; i < n; i++) {
      const env = Math.exp(-i / (SAMPLE_RATE * tau));
      let s = Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE) * env;
      if (sound === "woodblock")
        s += 0.3 * Math.sin((2 * Math.PI * f * 2.7 * i) / SAMPLE_RATE) * env;
      out[i] = 0.8 * s;
    }
  }
  for (let i = 0; i < n; i++) {
    const a = i < attack ? i / attack : 1;
    const r = i > n - release ? (n - i) / release : 1;
    out[i] = (out[i] ?? 0) * a * r * gain;
  }
  return out;
}

export type ClickSampleSet = [Float32Array, Float32Array, Float32Array];

export function clickSamples(sound: ClickSound): ClickSampleSet {
  return [synthClick(sound, 0), synthClick(sound, 1), synthClick(sound, 2)];
}

/** The sample a pulse of `level` plays: with the accent off, downbeats sound like beats. */
export function clickSampleLevel(level: number, accent: boolean): ClickLevel {
  return level === 0 && !accent ? 1 : level <= 0 ? 0 : level === 1 ? 1 : 2;
}
