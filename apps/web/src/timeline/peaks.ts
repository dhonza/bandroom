/**
 * Waveform peaks (SPEC §11.6): audiowaveform `.dat` v1 parsed into a min/max pyramid
 * (256 → 512 → 1024 … samples per pixel). Values are int16 (−32768…32767) whether the file is
 * 16-bit or older 8-bit (scaled × 256). Pure functions, shared by the worker and tests.
 */
export interface PeakLevel {
  /** Source samples per entry. */
  spp: number;
  mins: Int16Array;
  maxs: Int16Array;
}

export interface Pyramid {
  sampleRate: number;
  /** Source length in samples (approximate: whole 256-sample blocks). */
  lengthSamples: number;
  levels: PeakLevel[];
}

export function parseDat(buf: ArrayBuffer): {
  sampleRate: number;
  spp: number;
  mins: Int16Array;
  maxs: Int16Array;
} {
  const dv = new DataView(buf);
  if (dv.getInt32(0, true) !== 1) throw new Error("Unsupported peaks file");
  const eightBit = (dv.getUint32(4, true) & 1) === 1;
  const sampleRate = dv.getInt32(8, true);
  const spp = dv.getInt32(12, true);
  const length = dv.getUint32(16, true);
  const mins = new Int16Array(length);
  const maxs = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    if (eightBit) {
      mins[i] = dv.getInt8(20 + 2 * i) * 256;
      maxs[i] = dv.getInt8(21 + 2 * i) * 256;
    } else {
      mins[i] = dv.getInt16(20 + 4 * i, true);
      maxs[i] = dv.getInt16(22 + 4 * i, true);
    }
  }
  return { sampleRate, spp, mins, maxs };
}

/** Halves resolution until fewer than `minEntries` remain. */
export function buildPyramid(
  base: { sampleRate: number; spp: number; mins: Int16Array; maxs: Int16Array },
  minEntries = 512,
): Pyramid {
  const levels: PeakLevel[] = [{ spp: base.spp, mins: base.mins, maxs: base.maxs }];
  let cur = levels[0];
  while (cur && cur.mins.length > minEntries) {
    const n = Math.ceil(cur.mins.length / 2);
    const mins = new Int16Array(n);
    const maxs = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const a = 2 * i;
      const b = Math.min(a + 1, cur.mins.length - 1);
      mins[i] = Math.min(cur.mins[a] ?? 0, cur.mins[b] ?? 0);
      maxs[i] = Math.max(cur.maxs[a] ?? 0, cur.maxs[b] ?? 0);
    }
    cur = { spp: cur.spp * 2, mins, maxs };
    levels.push(cur);
  }
  return { sampleRate: base.sampleRate, lengthSamples: base.mins.length * base.spp, levels };
}

/** The coarsest level whose resolution is still at least one entry per pixel. */
export function pickLevel(p: Pyramid, samplesPerPixel: number): PeakLevel {
  let best = p.levels[0];
  for (const l of p.levels) if (l.spp <= samplesPerPixel) best = l;
  if (!best) throw new Error("empty pyramid");
  return best;
}

/** Min/max (−32768…32767) over the source-sample range [from, to). */
export function rangePeak(level: PeakLevel, from: number, to: number): [number, number] | null {
  const n = level.mins.length;
  const a = Math.max(0, Math.floor(from / level.spp));
  const b = Math.min(n, Math.max(a + 1, Math.ceil(to / level.spp)));
  if (a >= n || b <= 0) return null;
  let mn = 32_767;
  let mx = -32_768;
  for (let i = a; i < b; i++) {
    const lo = level.mins[i] ?? 0;
    const hi = level.maxs[i] ?? 0;
    if (lo < mn) mn = lo;
    if (hi > mx) mx = hi;
  }
  return [mn, mx];
}
