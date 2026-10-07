import { MANUAL_MAX_BPM, MANUAL_MIN_BPM, type MidiWarning } from "@bandroom/shared";
import { formatBpmRange, type TempoSummary } from "./model";

/** Pure helpers for the tempo dialog: MIDI import warnings, summaries and input rounding. */

/** The i18n key and parameters of a MIDI import warning. */
export function midiWarningKey(w: MidiWarning): {
  key: `tempo.midi.warnings.${MidiWarning["code"]}`;
  params: Record<string, number>;
} {
  switch (w.code) {
    case "meterRounded":
      return { key: "tempo.midi.warnings.meterRounded", params: { bar: w.bar } };
    case "tempoClamped":
      return { key: "tempo.midi.warnings.tempoClamped", params: { bpm: w.bpm } };
    case "tooManyMarkers":
      return { key: "tempo.midi.warnings.tooManyMarkers", params: { count: w.count } };
    default:
      return { key: "tempo.midi.warnings.noTempo", params: {} };
  }
}

/** Parameters of the `tempo.summary` text ("120 BPM · 4/4"). */
export function tempoSummaryParams(s: TempoSummary): { bpm: string; meter: string } {
  return { bpm: formatBpmRange(s), meter: s.meters.join(", ") };
}

/** A tapped tempo within the manual editor's range. */
export function clampManualBpm(bpm: number): number {
  return Math.min(MANUAL_MAX_BPM, Math.max(MANUAL_MIN_BPM, bpm));
}

/** Seconds rounded to whole milliseconds (the bar 1 offset's precision). */
export function roundMs(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}

/** The offset input's value as seconds (empty or invalid input is 0). */
export function offsetFromInput(v: number | string): number {
  return typeof v === "number" ? v : Number(v) || 0;
}

/** A copy of `set` with `i` toggled. */
export function toggled(set: ReadonlySet<number>, i: number): Set<number> {
  const n = new Set(set);
  if (n.has(i)) n.delete(i);
  else n.add(i);
  return n;
}
