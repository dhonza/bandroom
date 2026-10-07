import {
  barQuarters,
  beatQuarters,
  beatsPerBar,
  BEAT_EPS,
  isCompound,
  type Meter,
  type Tempo,
} from "./model";

/**
 * Tempo math (SPEC §7.1): conversions between song seconds, quarter-note beats and bars, grid
 * lines, snapping and click pulses. Pure functions over a compiled {@link TempoGrid}.
 *
 * Beats before bar 1 are negative; they use the first segment's tempo and meter, and their bars
 * are numbered 0, −1, … (pickup). A segment with `bpmEnd` ramps linearly in beats to that tempo
 * at the next segment.
 */

interface Seg {
  startBeat: number;
  /** Seconds from bar 1 (not from the song start). */
  startSec: number;
  bpm: number;
  /** BPM change per beat (0 = constant). */
  slope: number;
}

interface Region {
  startBeat: number;
  startBar: number;
  meter: Meter;
  barQ: number;
}

export interface TempoGrid {
  readonly offset: number;
  readonly segs: readonly Seg[];
  readonly regions: readonly Region[];
}

/** Seconds for `x` beats into a segment. */
function segSeconds(s: Seg, x: number): number {
  return s.slope === 0
    ? (x * 60) / s.bpm
    : (60 / s.slope) * Math.log((s.bpm + s.slope * x) / s.bpm);
}

/** Beats for `t` seconds into a segment. */
function segBeats(s: Seg, t: number): number {
  return s.slope === 0 ? (t * s.bpm) / 60 : (s.bpm * (Math.exp((s.slope * t) / 60) - 1)) / s.slope;
}

/** Index of the last item whose key is ≤ `v` (0 when none). */
function lastAtOrBefore<T>(items: readonly T[], key: (t: T) => number, v: number): number {
  let lo = 0;
  let hi = items.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (key(items[mid] as T) <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Precomputes segment start times and meter regions. Expects a validated map. */
export function compileTempo(t: Tempo): TempoGrid {
  const src = t.map.segments;
  const segs: Seg[] = [];
  const regions: Region[] = [];
  src.forEach((s, i) => {
    const next = src[i + 1];
    const slope =
      next && s.bpmEnd !== undefined ? (s.bpmEnd - s.bpm) / (next.startBeat - s.startBeat) : 0;
    const prev = segs[i - 1];
    const startSec = prev ? prev.startSec + segSeconds(prev, s.startBeat - prev.startBeat) : 0;
    segs.push({ startBeat: s.startBeat, startSec, bpm: s.bpm, slope });
    const r = regions.at(-1);
    if (!r || r.meter.num !== s.meter.num || r.meter.den !== s.meter.den) {
      regions.push({
        startBeat: s.startBeat,
        startBar: s.barIndex,
        meter: s.meter,
        barQ: barQuarters(s.meter),
      });
    }
  });
  return { offset: t.bar1OffsetSec, segs, regions };
}

const first = (g: TempoGrid): Seg => g.segs[0] as Seg;

/** Quarter-note beat (from bar 1) → song seconds. */
export function beatToSec(g: TempoGrid, beat: number): number {
  if (beat <= 0) return g.offset + (beat * 60) / first(g).bpm;
  const s = g.segs[lastAtOrBefore(g.segs, (x) => x.startBeat, beat)] as Seg;
  return g.offset + s.startSec + segSeconds(s, beat - s.startBeat);
}

/** Song seconds → quarter-note beat from bar 1 (negative before bar 1). */
export function secToBeat(g: TempoGrid, sec: number): number {
  const rel = sec - g.offset;
  if (rel <= 0) return (rel * first(g).bpm) / 60;
  const s = g.segs[lastAtOrBefore(g.segs, (x) => x.startSec, rel)] as Seg;
  return s.startBeat + segBeats(s, rel - s.startSec);
}

/** Quarter-note BPM in effect at `beat`. */
export function bpmAtBeat(g: TempoGrid, beat: number): number {
  if (beat <= 0) return first(g).bpm;
  const s = g.segs[lastAtOrBefore(g.segs, (x) => x.startBeat, beat)] as Seg;
  return s.bpm + s.slope * (beat - s.startBeat);
}

/** Meter region at `beat`; a beat a rounding error before a meter change belongs to it. */
function regionAt(g: TempoGrid, beat: number): Region {
  return g.regions[lastAtOrBefore(g.regions, (r) => r.startBeat, beat + BEAT_EPS)] as Region;
}

export interface BarInfo {
  /** 0-based bar index (bar 1 = 0, pickup bars negative). */
  index: number;
  startBeat: number;
  meter: Meter;
}

/** The bar containing `beat`. */
export function barAtBeat(g: TempoGrid, beat: number): BarInfo {
  const r = regionAt(g, beat);
  const n = Math.floor((beat - r.startBeat) / r.barQ + BEAT_EPS);
  return { index: r.startBar + n, startBeat: r.startBeat + n * r.barQ, meter: r.meter };
}

/** Bar by 0-based index. */
export function barByIndex(g: TempoGrid, index: number): BarInfo {
  const r = g.regions[lastAtOrBefore(g.regions, (x) => x.startBar, index)] as Region;
  return { index, startBeat: r.startBeat + (index - r.startBar) * r.barQ, meter: r.meter };
}

/** Counted beats in a bar (1-based bar number as displayed; SPEC §7.1 `beatsInBar`). */
export function beatsInBar(g: TempoGrid, bar: number): number {
  return beatsPerBar(barByIndex(g, bar - 1).meter);
}

/** Ticks per counted beat for the "bar.beat.tick" readout: sixteenths, eighths in compound. */
function ticksPerBeat(m: Meter): number {
  return isCompound(m) ? 3 : 4;
}

export interface BarBeat {
  /** 1-based bar number; 0, −1, … are pickup bars. */
  bar: number;
  /** 1-based counted beat within the bar. */
  beat: number;
  /** 1-based tick within the beat. */
  tick: number;
}

/** Song seconds → bar.beat.tick (SPEC §7.1, "17.3.2"). */
export function secToBarBeat(g: TempoGrid, sec: number): BarBeat {
  const b = secToBeat(g, sec);
  const bar = barAtBeat(g, b);
  const unit = beatQuarters(bar.meter);
  const pos = Math.max(0, (b - bar.startBeat) / unit);
  const beat = Math.min(beatsPerBar(bar.meter) - 1, Math.floor(pos + BEAT_EPS));
  const tpb = ticksPerBeat(bar.meter);
  const tick = Math.min(tpb - 1, Math.max(0, Math.floor((pos - beat) * tpb + BEAT_EPS)));
  return { bar: bar.index + 1, beat: beat + 1, tick: tick + 1 };
}

/** bar.beat.tick → song seconds. */
export function barBeatToSec(g: TempoGrid, bar: number, beat = 1, tick = 1): number {
  const b = barByIndex(g, bar - 1);
  const unit = beatQuarters(b.meter);
  const q = b.startBeat + (beat - 1) * unit + ((tick - 1) * unit) / ticksPerBeat(b.meter);
  return beatToSec(g, q);
}

/** "17.3" (or "17.3.2" with ticks). */
export function formatBarBeat(bb: BarBeat, withTick = false): string {
  return withTick ? `${bb.bar}.${bb.beat}.${bb.tick}` : `${bb.bar}.${bb.beat}`;
}

export interface TempoAt {
  bpm: number;
  meter: Meter;
}

/** Tempo and meter at a song position. */
export function tempoAt(g: TempoGrid, sec: number): TempoAt {
  const b = secToBeat(g, sec);
  return { bpm: bpmAtBeat(g, b), meter: barAtBeat(g, b).meter };
}

// ——— grid and pulses ———————————————————————————————————————————————————————————————

/** Snap/grid resolutions (SPEC §7.5): half and quarter are fractions of the counted beat. */
export const GRID_RESOLUTIONS = ["bar", "beat", "half", "quarter"] as const;
export type GridResolution = (typeof GRID_RESOLUTIONS)[number];

/** A pulse pattern: `main` pulses (quarters) split into `parts`. */
interface Pattern {
  main: number;
  parts: number;
}

/** Fraction of a beat: compound beats split in thirds (eighths) and sixths (SPEC §6.7). */
function subParts(m: Meter, sub: 1 | 2 | 4): number {
  if (sub === 1) return 1;
  if (isCompound(m)) return sub === 2 ? 3 : 6;
  return sub;
}

function gridPattern(res: GridResolution, m: Meter): Pattern {
  if (res === "bar") return { main: barQuarters(m), parts: 1 };
  const parts = res === "beat" ? 1 : subParts(m, res === "half" ? 2 : 4);
  return { main: beatQuarters(m), parts };
}

export interface ClickOptions {
  /** Pulses per counted beat (SPEC §6.7). */
  subdivision: 1 | 2 | 4;
  /** Compound meters click every eighth instead of on dotted beats. */
  compoundEighths: boolean;
}

function clickPattern(o: ClickOptions, m: Meter): Pattern {
  if (isCompound(m) && o.compoundEighths) return { main: 4 / m.den, parts: o.subdivision };
  return { main: beatQuarters(m), parts: subParts(m, o.subdivision) };
}

export interface Pulse {
  sec: number;
  /** Quarter-note beat from bar 1. */
  beat: number;
  /** 0 = bar downbeat, 1 = main pulse, 2 = subdivision. */
  level: 0 | 1 | 2;
  /** 1-based bar number. */
  bar: number;
}

/** Safety cap for one call (a 10 min song at 400 BPM in sixteenths is ~16 000). */
export const MAX_PULSES = 200_000;

function pulses(
  g: TempoGrid,
  fromSec: number,
  toSec: number,
  pattern: (m: Meter) => Pattern,
): Pulse[] {
  const out: Pulse[] = [];
  if (!(toSec >= fromSec)) return out;
  const fromBeat = secToBeat(g, fromSec) - BEAT_EPS;
  const toBeat = secToBeat(g, toSec) + BEAT_EPS;
  let bar = barAtBeat(g, fromBeat);
  while (bar.startBeat <= toBeat && out.length < MAX_PULSES) {
    const barQ = barQuarters(bar.meter);
    const p = pattern(bar.meter);
    const step = p.main / p.parts;
    const count = Math.max(1, Math.round(barQ / step));
    for (let j = 0; j < count; j++) {
      const beat = bar.startBeat + j * step;
      if (beat < fromBeat) continue;
      if (beat > toBeat) break;
      const level = j === 0 ? 0 : j % p.parts === 0 ? 1 : 2;
      out.push({ sec: beatToSec(g, beat), beat, level, bar: bar.index + 1 });
    }
    bar = barByIndex(g, bar.index + 1);
  }
  return out;
}

/** Grid lines between two song positions (SPEC §7.1 `gridLines`). */
export function gridLines(
  g: TempoGrid,
  fromSec: number,
  toSec: number,
  res: GridResolution,
): Pulse[] {
  return pulses(g, fromSec, toSec, (m) => gridPattern(res, m));
}

/** Click pulses (SPEC §6.7) between two song positions. */
export function clickPulses(
  g: TempoGrid,
  fromSec: number,
  toSec: number,
  opts: ClickOptions,
): Pulse[] {
  return pulses(g, fromSec, toSec, (m) => clickPattern(opts, m));
}

/** Grid step at `beat` in quarter notes, and the bar it lies in. */
function stepAt(g: TempoGrid, beat: number, res: GridResolution) {
  const bar = barAtBeat(g, beat);
  const p = gridPattern(res, bar.meter);
  return { bar, step: p.main / p.parts };
}

/** Nearest grid line (SPEC §7.1 `snap`). */
export function snapToGrid(g: TempoGrid, sec: number, res: GridResolution): number {
  const b = secToBeat(g, sec);
  const { bar, step } = stepAt(g, b, res);
  const j = Math.round((b - bar.startBeat) / step);
  return beatToSec(g, bar.startBeat + j * step);
}

/**
 * The next (dir 1) or previous (dir −1) grid line strictly more than `toleranceSec` away:
 * musical nudges `←/→` (SPEC §7.6).
 */
export function stepGrid(
  g: TempoGrid,
  sec: number,
  dir: -1 | 1,
  res: GridResolution,
  toleranceSec = 0.01,
): number {
  const b = secToBeat(g, sec + dir * toleranceSec);
  const { bar, step } = stepAt(g, b, res);
  const j = Math.floor((b - bar.startBeat) / step + BEAT_EPS) + (dir > 0 ? 1 : 0);
  return beatToSec(g, bar.startBeat + j * step);
}

export interface CountIn {
  /** Number of clicks. */
  clicks: number;
  /** Clicks per bar (the first of each bar is accented). */
  perBar: number;
  /** Seconds between clicks. */
  intervalSec: number;
}

/** Count-in before `sec` with the tempo and meter in effect there (SPEC §6.7). */
export function countInAt(
  g: TempoGrid,
  sec: number,
  bars: number,
  compoundEighths: boolean,
): CountIn {
  const b = secToBeat(g, sec + 1e-6);
  const meter = barAtBeat(g, b).meter;
  const p = clickPattern({ subdivision: 1, compoundEighths }, meter);
  const perBar = Math.max(1, Math.round(barQuarters(meter) / p.main));
  return { clicks: bars * perBar, perBar, intervalSec: (p.main * 60) / bpmAtBeat(g, b) };
}
