import {
  barAtBeat,
  barByIndex,
  barQuarters,
  BEAT_EPS,
  beatQuarters,
  bpmAtBeat,
  compileTempo,
  formatMeter,
  MANUAL_MAX_BPM,
  MANUAL_MIN_BPM,
  normalizeSegments,
  sameMeter,
  type Meter,
  type TempoIssue,
  type TempoMap,
  type TempoSegment,
  type TempoSegmentInput,
} from "@bandroom/shared";

/** Tempo editing helpers (SPEC §7.3): tap tempo, meters, tempo-change rows, summaries. */

/** Taps further apart than this start a new measurement. */
export const TAP_RESET_MS = 2000;
/** "Average of the last 4–8 taps" (SPEC §7.3). */
export const TAP_MIN = 4;
export const TAP_MAX = 8;

/** Adds a tap (ms timestamp) and returns the taps kept for the next measurement. */
export function addTap(taps: readonly number[], now: number): number[] {
  const last = taps.at(-1);
  const kept = last !== undefined && now - last <= TAP_RESET_MS ? [...taps, now] : [now];
  return kept.slice(-TAP_MAX);
}

/** BPM from the taps (average interval), or null with fewer than 4 taps. */
export function tapBpm(taps: readonly number[]): number | null {
  if (taps.length < TAP_MIN) return null;
  const first = taps[0] as number;
  const last = taps.at(-1) as number;
  const avg = (last - first) / (taps.length - 1);
  if (avg <= 0) return null;
  return Math.round((60_000 / avg) * 10) / 10;
}

/** Meter presets of the manual form (SPEC §7.3 "common presets + custom"). */
export const METER_PRESETS = ["4/4", "3/4", "2/4", "6/8", "12/8", "9/8", "5/4", "7/8", "2/2"];

export function parseMeter(s: string): Meter | null {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(s);
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (num < 1 || num > 32 || ![1, 2, 4, 8, 16, 32].includes(den)) return null;
  return { num, den };
}

export interface TempoSummary {
  bpmMin: number;
  bpmMax: number;
  meters: string[];
  changes: number;
}

export function summarize(map: TempoMap): TempoSummary {
  const bpms = map.segments.flatMap((s) => [s.bpm, ...(s.bpmEnd !== undefined ? [s.bpmEnd] : [])]);
  const meters = [...new Set(map.segments.map((s) => formatMeter(s.meter)))];
  return {
    bpmMin: Math.min(...bpms),
    bpmMax: Math.max(...bpms),
    meters,
    changes: map.segments.length - 1,
  };
}

/** "120" or "96–128" (BPM rounded to 0.1). */
export function formatBpmRange(s: TempoSummary): string {
  const r = (x: number) => String(Math.round(x * 10) / 10);
  return s.bpmMin === s.bpmMax ? r(s.bpmMin) : `${r(s.bpmMin)}–${r(s.bpmMax)}`;
}

// ——— bar-based change rows (SPEC §7.1, §7.3) ——————————————————————————————————————————

/**
 * The tempo editor works on bars, not beats: bar 1 (the head) plus a list of changes, each at a
 * bar (and, for tempo changes, a counted beat within it). Positions are converted to quarter-note
 * beats only when saving or previewing ({@link mapFromRows}), so editing an earlier time
 * signature keeps later changes on their bar numbers. Input values stay raw (as typed) until then.
 */
export interface HeadRow {
  bpm: number | string;
  /** Time signature as typed ("4/4"). */
  meter: string;
  /** Imported ramp to the next change's tempo (kept, not editable). */
  bpmEnd?: number;
}

export interface ChangeRow {
  id: string;
  /** 1-based bar, ≥ 2. */
  bar: number | string;
  /** 1-based counted beat within the bar (may be fractional); only tempo changes may be off beat 1. */
  beat: number | string;
  /** null: keeps the tempo. */
  bpm: number | string | null;
  /** null: keeps the time signature. */
  meter: string | null;
  bpmEnd?: number;
}

export type ChangeKind = "tempo" | "meter";

/** Highest bar the editor accepts. */
export const MAX_EDIT_BAR = 9999;

export type RowError =
  "bpm" | "meter" | "bar" | "beat" | "duplicate" | "meterOffBeat" | TempoIssue["code"];

let rowSeq = 0;
/** Stable React key for a new row. */
export function newRowId(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** A map (normalized) → bar 1 and its changes; only what differs from before becomes a row. */
export function rowsFromMap(map: TempoMap): { head: HeadRow; rows: ChangeRow[] } {
  const segs = map.segments;
  const s0 = segs[0] as TempoSegment;
  const head: HeadRow = { bpm: s0.bpm, meter: formatMeter(s0.meter) };
  if (s0.bpmEnd !== undefined) head.bpmEnd = s0.bpmEnd;
  const grid = compileTempo({ map, bar1OffsetSec: 0 });
  const rows: ChangeRow[] = [];
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i] as TempoSegment;
    const prev = segs[i - 1] as TempoSegment;
    const tempo = s.bpm !== prev.bpm || s.bpmEnd !== undefined || prev.bpmEnd !== undefined;
    const meter = !sameMeter(s.meter, prev.meter);
    if (!tempo && !meter) continue;
    const bar = barAtBeat(grid, s.startBeat);
    const row: ChangeRow = {
      id: newRowId(),
      bar: bar.index + 1,
      beat: round6(1 + (s.startBeat - bar.startBeat) / beatQuarters(bar.meter)),
      bpm: tempo ? s.bpm : null,
      meter: meter ? formatMeter(s.meter) : null,
    };
    if (s.bpmEnd !== undefined) row.bpmEnd = s.bpmEnd;
    rows.push(row);
  }
  return { head, rows };
}

const num = (v: number | string): number => (typeof v === "number" ? v : Number.NaN);
const validBpm = (v: number) => v >= MANUAL_MIN_BPM && v <= MANUAL_MAX_BPM;

interface Parsed {
  row: ChangeRow;
  bar: number;
  beat: number;
  bpm: number | null;
  meter: Meter | null;
}

export type RowsResult =
  { ok: true; segments: TempoSegment[] } | { ok: false; error: RowError; rowId?: string };

/**
 * Bar 1 and change rows → normalized segments (quarter-note beats), or the first problem.
 * Rows are bar-anchored: each one's beat position follows from the time signatures before it.
 * Rows with neither a tempo nor a time signature are ignored.
 */
export function mapFromRows(head: HeadRow, rows: readonly ChangeRow[]): RowsResult {
  const headBpm = num(head.bpm);
  const headMeter = parseMeter(head.meter);
  if (!validBpm(headBpm)) return { ok: false, error: "bpm" };
  if (!headMeter) return { ok: false, error: "meter" };
  const parsed: Parsed[] = [];
  for (const row of rows) {
    if (row.bpm === null && row.meter === null) continue;
    const bar = num(row.bar);
    const beat = num(row.beat);
    const bpm = row.bpm === null ? null : num(row.bpm);
    const meter = row.meter === null ? null : parseMeter(row.meter);
    const fail = (error: RowError): RowsResult => ({ ok: false, error, rowId: row.id });
    if (!Number.isInteger(bar) || bar < 2 || bar > MAX_EDIT_BAR) return fail("bar");
    if (!(beat >= 1)) return fail("beat");
    if (bpm !== null && !validBpm(bpm)) return fail("bpm");
    if (row.meter !== null && !meter) return fail("meter");
    if (meter && Math.abs(beat - 1) > BEAT_EPS) return fail("meterOffBeat");
    parsed.push({ row, bar, beat, bpm, meter });
  }
  parsed.sort((a, b) => a.bar - b.bar || a.beat - b.beat);

  const out: TempoSegmentInput[] = [
    {
      startBeat: 0,
      bpm: headBpm,
      meter: headMeter,
      ...(head.bpmEnd !== undefined && { bpmEnd: head.bpmEnd }),
    },
  ];
  // Meter region in effect: its first bar and beat.
  let meter = headMeter;
  let regionBar = 1;
  let regionBeat = 0;
  let bpm = headBpm;
  let prev: Parsed | null = null;
  for (const p of parsed) {
    const fail = (error: RowError): RowsResult => ({ ok: false, error, rowId: p.row.id });
    if (prev && prev.bar === p.bar && Math.abs(prev.beat - p.beat) <= BEAT_EPS) {
      return fail("duplicate");
    }
    prev = p;
    const barStart = regionBeat + (p.bar - regionBar) * barQuarters(meter);
    if (p.meter) {
      meter = p.meter;
      regionBar = p.bar;
      regionBeat = barStart;
    }
    const offset = (p.beat - 1) * beatQuarters(meter);
    if (offset >= barQuarters(meter) - BEAT_EPS) return fail("beat");
    if (p.bpm !== null) bpm = p.bpm;
    const seg: TempoSegmentInput = { startBeat: barStart + offset, bpm, meter };
    if (p.bpm !== null && p.row.bpmEnd !== undefined) seg.bpmEnd = p.row.bpmEnd;
    out.push(seg);
  }
  // A ramp needs a following change; drop it when that change was deleted.
  const last = out.at(-1) as TempoSegmentInput;
  delete last.bpmEnd;
  const n = normalizeSegments(out);
  /* v8 ignore next -- the rows were checked above (bars, beats, order, ramp); a safety net */
  if (!n.ok) return { ok: false, error: n.issue.code };
  return { ok: true, segments: n.segments };
}

/** Tempo (rounded to 0.001 BPM) and time signature at the start of bar `bar` (1-based). */
export function inEffectAtBar(
  segments: readonly TempoSegment[],
  bar: number,
): { bpm: number; meter: string } {
  const grid = compileTempo({ map: { segments: [...segments] }, bar1OffsetSec: 0 });
  const at = barByIndex(grid, bar - 1);
  return {
    bpm: Math.round(bpmAtBeat(grid, at.startBeat) * 1000) / 1000,
    meter: formatMeter(at.meter),
  };
}

/**
 * Adds a tempo or time signature change at the start of bar `bar` (SPEC §7.3 "Add tempo change
 * at bar N"), prefilled with what is in effect there. A row already at that bar's first beat gets
 * the new aspect switched on instead. Null when the bar is invalid, the rows do not form a valid
 * map, or the row at that bar already has that aspect.
 */
export function addChangeAtBar(
  head: HeadRow,
  rows: readonly ChangeRow[],
  bar: number,
  kind: ChangeKind,
): ChangeRow[] | null {
  if (!Number.isInteger(bar) || bar < 2 || bar > MAX_EDIT_BAR) return null;
  const r = mapFromRows(head, rows);
  if (!r.ok) return null;
  const now = inEffectAtBar(r.segments, bar);
  const value = kind === "tempo" ? { bpm: now.bpm } : { meter: now.meter };
  const i = rows.findIndex((x) => num(x.bar) === bar && Math.abs(num(x.beat) - 1) <= BEAT_EPS);
  const existing = rows[i];
  if (existing) {
    if ((kind === "tempo" ? existing.bpm : existing.meter) !== null) return null;
    return rows.map((x, j) => (j === i ? { ...x, ...value } : x));
  }
  const row: ChangeRow = { id: newRowId(), bar, beat: 1, bpm: null, meter: null, ...value };
  return [...rows, row].sort((a, b) => num(a.bar) - num(b.bar) || num(a.beat) - num(b.beat));
}
