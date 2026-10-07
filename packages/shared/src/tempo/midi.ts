import { parseMidi, type MidiData } from "midi-file";
import {
  barQuarters,
  BEAT_EPS,
  MAX_BPM,
  MIN_BPM,
  normalizeSegments,
  sameMeter,
  type Meter,
  type TempoMap,
  type TempoSegmentInput,
} from "./model";

/**
 * Tempo map import from a Standard MIDI File (SPEC §7.2): `setTempo` (FF 51) and
 * `timeSignature` (FF 58) meta events become segments, marker (FF 06) and cue point (FF 07)
 * events are listed for import as song markers. MIDI time 0 is song time 0, so bar 1 starts at
 * 0 s. Handles the Reaper ("Export project MIDI") and Logic (tempo track export) conventions:
 * events in any track, duplicates at one tick (the last wins), no tempo or meter at tick 0.
 */

export const MIDI_ERRORS = ["MIDI_INVALID", "MIDI_SMPTE", "MIDI_FORMAT"] as const;
export type MidiError = (typeof MIDI_ERRORS)[number];

export interface MidiMarker {
  /** Trimmed, at most 60 characters; may be empty. */
  name: string;
  /** Quarter-note beat from bar 1. */
  beat: number;
  kind: "marker" | "cue";
}

export type MidiWarning =
  /** A meter change off a bar line was moved to the nearest bar (1-based bar number). */
  | { code: "meterRounded"; bar: number }
  /** No tempo event: 120 BPM assumed (the MIDI default). */
  | { code: "noTempo" }
  /** A tempo outside 10–1000 BPM was clamped. */
  | { code: "tempoClamped"; bpm: number }
  /** More markers than can be imported; the rest were dropped. */
  | { code: "tooManyMarkers"; count: number };

export interface MidiTempoImport {
  map: TempoMap;
  bar1OffsetSec: number;
  markers: MidiMarker[];
  warnings: MidiWarning[];
  /** Ticks per quarter note. */
  ppq: number;
  format: number;
  /** Tempo events found (a ramp exported by Reaper arrives as many of them). */
  tempoEvents: number;
}

export type MidiTempoResult =
  { ok: true; value: MidiTempoImport } | { ok: false; error: MidiError };

export const MAX_MIDI_MARKERS = 500;
export const MAX_MIDI_BYTES = 1024 * 1024;
const DEFAULT_BPM = 120;
const DEFAULT_METER: Meter = { num: 4, den: 4 };

/** Strict UTF-8 decoding (no TextDecoder: shared code targets plain ES2023); null if invalid. */
export function decodeUtf8(bytes: readonly number[]): string | null {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i] as number;
    const n = b < 0x80 ? 0 : b < 0xc2 ? -1 : b < 0xe0 ? 1 : b < 0xf0 ? 2 : b < 0xf5 ? 3 : -1;
    if (n < 0) return null;
    let cp = n === 0 ? b : b & (0x3f >> n);
    for (let k = 1; k <= n; k++) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    const min = [0, 0x80, 0x800, 0x10000][n] as number;
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out += String.fromCodePoint(cp);
    i += n + 1;
  }
  return out;
}

/** midi-file returns text as one char per byte: decode UTF-8 when valid, else Latin-1. */
export function decodeMidiText(raw: string): string {
  return decodeUtf8(Array.from(raw, (c) => c.charCodeAt(0) & 0xff)) ?? raw;
}

interface At<T> {
  tick: number;
  value: T;
}

/** Sorted by tick; of several events at one tick the last one wins. */
function lastPerTick<T>(events: At<T>[]): At<T>[] {
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.tick - b.e.tick || a.i - b.i)
    .map((x) => x.e);
  const out: At<T>[] = [];
  for (const e of sorted) {
    if (out.at(-1)?.tick === e.tick) out[out.length - 1] = e;
    else out.push(e);
  }
  return out;
}

function readEvents(midi: MidiData) {
  const tempos: At<number>[] = [];
  const meters: At<Meter>[] = [];
  const markers: At<{ name: string; kind: "marker" | "cue" }>[] = [];
  for (const track of midi.tracks) {
    let tick = 0;
    for (const e of track) {
      tick += e.deltaTime;
      // BPM to 3 decimals, as DAWs show it (µs per beat are integers: 140 → 428 571 µs).
      if (e.type === "setTempo")
        tempos.push({ tick, value: Math.round(60_000_000_000 / e.microsecondsPerBeat) / 1000 });
      else if (e.type === "timeSignature")
        meters.push({ tick, value: { num: e.numerator, den: e.denominator } });
      else if (e.type === "marker" || e.type === "cuePoint")
        markers.push({
          tick,
          value: {
            name: decodeMidiText(e.text).trim().slice(0, 60),
            kind: e.type === "marker" ? "marker" : "cue",
          },
        });
    }
  }
  return { tempos, meters, markers };
}

interface Tempo {
  beat: number;
  bpm: number;
}
interface MeterAt {
  beat: number;
  meter: Meter;
}

const validMeter = (m: Meter) => m.num >= 1 && m.num <= 32 && [1, 2, 4, 8, 16, 32].includes(m.den);

/** Parses a MIDI file into a tempo map and its markers. */
export function parseMidiTempo(bytes: Uint8Array): MidiTempoResult {
  let midi: MidiData;
  try {
    midi = parseMidi(bytes);
  } catch {
    return { ok: false, error: "MIDI_INVALID" };
  }
  const { format } = midi.header;
  if (format !== 0 && format !== 1) return { ok: false, error: "MIDI_FORMAT" };
  const ppq = midi.header.ticksPerBeat;
  if (ppq === undefined) return { ok: false, error: "MIDI_SMPTE" };
  if (ppq <= 0) return { ok: false, error: "MIDI_INVALID" };

  const warnings: MidiWarning[] = [];
  const events = readEvents(midi);
  const tempos: Tempo[] = lastPerTick(events.tempos).map((t) => {
    const bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, t.value));
    if (bpm !== t.value) warnings.push({ code: "tempoClamped", bpm: Math.round(t.value) });
    return { beat: t.tick / ppq, bpm };
  });
  if (tempos.length === 0) warnings.push({ code: "noTempo" });
  if (tempos[0]?.beat !== 0) tempos.unshift({ beat: 0, bpm: DEFAULT_BPM });

  // Meter changes, moved to the nearest bar line of the meter before them (SPEC §7.1).
  const meters: MeterAt[] = [{ beat: 0, meter: DEFAULT_METER }];
  let bar = 0; // 0-based bar index where the last meter region starts
  for (const m of lastPerTick(events.meters)) {
    if (!validMeter(m.value)) continue;
    const cur = meters.at(-1) as MeterAt;
    const barQ = barQuarters(cur.meter);
    const exact = (m.tick / ppq - cur.beat) / barQ;
    const bars = Math.round(exact);
    if (sameMeter(m.value, cur.meter)) continue;
    if (Math.abs(exact - bars) * barQ > BEAT_EPS) {
      warnings.push({ code: "meterRounded", bar: bar + Math.max(0, bars) + 1 });
    }
    if (bars <= 0) {
      cur.meter = m.value; // replaces the meter of the region it starts
      continue;
    }
    bar += bars;
    meters.push({ beat: cur.beat + bars * barQ, meter: m.value });
  }

  // One segment wherever the tempo or the meter changes.
  const points: number[] = [];
  for (const b of [...tempos.map((t) => t.beat), ...meters.map((m) => m.beat)].sort(
    (x, y) => x - y,
  )) {
    if (points.length === 0 || b - (points.at(-1) as number) > BEAT_EPS) points.push(b);
  }
  const segments: TempoSegmentInput[] = [];
  let ti = 0;
  let mi = 0;
  for (const beat of points) {
    while (ti + 1 < tempos.length && (tempos[ti + 1] as Tempo).beat <= beat + BEAT_EPS) ti++;
    while (mi + 1 < meters.length && (meters[mi + 1] as MeterAt).beat <= beat + BEAT_EPS) mi++;
    const { bpm } = tempos[ti] as Tempo;
    const { meter } = meters[mi] as MeterAt;
    const prev = segments.at(-1);
    if (prev && prev.bpm === bpm && sameMeter(prev.meter, meter)) continue;
    segments.push({ startBeat: beat, bpm, meter });
  }
  const norm = normalizeSegments(segments);
  /* v8 ignore next -- segments are built on bar lines in order; kept as a safety net */
  if (!norm.ok) return { ok: false, error: "MIDI_INVALID" };

  const seen = new Set<string>();
  const markers: MidiMarker[] = [];
  for (const m of [...events.markers].sort((a, b) => a.tick - b.tick)) {
    const key = `${m.tick}:${m.value.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push({ name: m.value.name, beat: m.tick / ppq, kind: m.value.kind });
  }
  if (markers.length > MAX_MIDI_MARKERS) {
    warnings.push({ code: "tooManyMarkers", count: markers.length });
    markers.length = MAX_MIDI_MARKERS;
  }

  return {
    ok: true,
    value: {
      map: { segments: norm.segments },
      bar1OffsetSec: 0,
      markers,
      warnings,
      ppq,
      format,
      tempoEvents: events.tempos.length,
    },
  };
}
