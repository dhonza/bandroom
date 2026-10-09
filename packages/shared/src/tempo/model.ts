import { z } from "zod";

/**
 * Tempo map model (SPEC §7.1). Beats are quarter notes counted from the bar 1 downbeat (beat 0);
 * song time = `bar1OffsetSec + beatsToSeconds(beats)`. The math lives in `./math`.
 */

export const METER_DENOMINATORS = [1, 2, 4, 8, 16, 32] as const;

export const MeterSchema = z.object({
  num: z.number().int().min(1).max(32),
  den: z
    .number()
    .int()
    .refine((d) => (METER_DENOMINATORS as readonly number[]).includes(d), {
      message: "Unsupported meter denominator",
    }),
});
export type Meter = z.infer<typeof MeterSchema>;

/** Tempo limits for stored maps (imports may exceed the manual form's 20–400). */
export const MIN_BPM = 10;
export const MAX_BPM = 1000;
/** Manual tempo form limits (SPEC §7.3). */
export const MANUAL_MIN_BPM = 20;
export const MANUAL_MAX_BPM = 400;
export const MAX_SEGMENTS = 5000;
/** Bar 1 may start at most an hour into the song (or a minute before it). */
export const MAX_BAR1_OFFSET_SEC = 3600;

export const TempoSegmentSchema = z.object({
  /** Quarter notes from bar 1. */
  startBeat: z.number().min(0).max(1_000_000),
  /** Quarter-note BPM at the segment start. */
  bpm: z.number().min(MIN_BPM).max(MAX_BPM),
  /** Linear ramp (in beats) to this BPM at the next segment's start. */
  bpmEnd: z.number().min(MIN_BPM).max(MAX_BPM).optional(),
  meter: MeterSchema,
  /** 0-based bar index at `startBeat` (derived and cached; recomputed on validation). */
  barIndex: z.number().int().optional(),
  /**
   * A new bar starts here even off the bar grid (an edit joined two pieces of music, SPEC §24.4):
   * the bar grid restarts at this segment and the bar index continues (a cut-short bar before it
   * counts as one bar). Ignored on the first segment.
   */
  newBar: z.literal(true).optional(),
});
/** Segment input; the derived bar index is optional (editor, importer). */
export type TempoSegmentInput = z.infer<typeof TempoSegmentSchema>;

export interface TempoSegment {
  startBeat: number;
  bpm: number;
  bpmEnd?: number;
  meter: Meter;
  /** 0-based bar number at `startBeat` (bar 1 = 0). */
  barIndex: number;
  /** The bar grid restarts here (SPEC §24.4). */
  newBar?: true;
}

export interface TempoMap {
  segments: TempoSegment[];
}

/** Tolerance for "on a bar line" and beat comparisons (quarter notes). */
export const BEAT_EPS = 1e-6;

/** Quarter notes in one bar of `m` (4/4 → 4, 6/8 → 3, 7/8 → 3.5). */
export function barQuarters(m: Meter): number {
  return (m.num * 4) / m.den;
}

/** 6/8, 9/8, 12/8 (and 6/16 …): counted in dotted beats (SPEC §6.7). */
export function isCompound(m: Meter): boolean {
  return m.den >= 8 && m.num >= 6 && m.num % 3 === 0;
}

/** Quarter notes per counted beat: the meter's beat unit, dotted in compound meters. */
export function beatQuarters(m: Meter): number {
  return ((isCompound(m) ? 3 : 1) * 4) / m.den;
}

/** Counted beats per bar (6/8 → 2, 7/8 → 7, 4/4 → 4). */
export function beatsPerBar(m: Meter): number {
  return isCompound(m) ? m.num / 3 : m.num;
}

export function sameMeter(a: Meter, b: Meter): boolean {
  return a.num === b.num && a.den === b.den;
}

export function formatMeter(m: Meter): string {
  return `${m.num}/${m.den}`;
}

export type TempoIssue =
  | { code: "empty" }
  | { code: "firstNotZero" }
  | { code: "order"; index: number }
  | { code: "meterOffBar"; index: number }
  | { code: "rampAtEnd" };

/**
 * Sorts nothing and fixes nothing: checks the rules of SPEC §7.1 and fills `barIndex`.
 * Returns the normalized segments or the first problem.
 */
export function normalizeSegments(
  input: readonly TempoSegmentInput[],
): { ok: true; segments: TempoSegment[] } | { ok: false; issue: TempoIssue } {
  const first = input[0];
  if (!first) return { ok: false, issue: { code: "empty" } };
  if (Math.abs(first.startBeat) > BEAT_EPS) return { ok: false, issue: { code: "firstNotZero" } };
  const out: TempoSegment[] = [];
  // Meter region currently in effect: where it started (beat) and at which bar.
  let regionBeat = 0;
  let regionBar = 0;
  let meter = first.meter;
  for (let i = 0; i < input.length; i++) {
    const s = input[i] as TempoSegmentInput;
    const prev = out[i - 1];
    const startBeat = i === 0 ? 0 : s.startBeat;
    if (prev && startBeat <= prev.startBeat + BEAT_EPS) {
      return { ok: false, issue: { code: "order", index: i } };
    }
    const newBar = i > 0 && s.newBar === true;
    if (newBar || !sameMeter(s.meter, meter)) {
      const bars = (startBeat - regionBeat) / barQuarters(meter);
      const whole = Math.round(bars);
      const onBar = Math.abs(bars - whole) * barQuarters(meter) < BEAT_EPS;
      if (!onBar && !newBar) {
        return { ok: false, issue: { code: "meterOffBar", index: i } };
      }
      // A bar cut short before a new bar still counts as a bar.
      regionBar += onBar ? whole : Math.floor(bars) + 1;
      regionBeat = startBeat;
      meter = s.meter;
    }
    const barIndex =
      regionBar + Math.floor((startBeat - regionBeat) / barQuarters(meter) + BEAT_EPS);
    const seg: TempoSegment = { startBeat, bpm: s.bpm, meter: s.meter, barIndex };
    if (newBar) seg.newBar = true;
    if (s.bpmEnd !== undefined && s.bpmEnd !== s.bpm) seg.bpmEnd = s.bpmEnd;
    out.push(seg);
  }
  if ((out.at(-1) as TempoSegment).bpmEnd !== undefined) {
    return { ok: false, issue: { code: "rampAtEnd" } };
  }
  return { ok: true, segments: out };
}

/** A normalized map as sent in responses (no transform, so it also serializes). */
export const TempoMapDataSchema = z.object({
  segments: z.array(TempoSegmentSchema.extend({ barIndex: z.number().int() })).max(MAX_SEGMENTS),
});

/** Validates (SPEC §7.1 rules) and normalizes a map: bar indexes are recomputed. */
export const TempoMapSchema = z
  .object({ segments: z.array(TempoSegmentSchema).min(1).max(MAX_SEGMENTS) })
  .transform((m, ctx): TempoMap => {
    const r = normalizeSegments(m.segments);
    if (r.ok) return { segments: r.segments };
    ctx.addIssue({ code: "custom", message: `Invalid tempo map: ${r.issue.code}` });
    return z.NEVER;
  });

export const Bar1OffsetSchema = z.number().min(-60).max(MAX_BAR1_OFFSET_SEC);

/** A song's tempo: the map plus where bar 1 starts on the song timeline. */
export interface Tempo {
  map: TempoMap;
  bar1OffsetSec: number;
}

/** A constant-tempo map (manual tempo, SPEC §7.3). */
export function constantTempoMap(bpm: number, meter: Meter): TempoMap {
  return { segments: [{ startBeat: 0, bpm, meter, barIndex: 0 }] };
}
