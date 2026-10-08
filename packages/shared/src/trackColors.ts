import type { PaletteColor } from "./content";
import { guessInstrument, matchesWordPrefix, nameWords, type Instrument } from "./instruments";

/**
 * Colours for new tracks (SPEC §25.10): by instrument when the name or instrument tag tells it,
 * else the first palette colour not used in the song yet, else round-robin by track count.
 */

/** The colour of each instrument (SPEC §25.10); `null` = no instrument colour. */
export const INSTRUMENT_COLORS: Record<Instrument, PaletteColor | null> = {
  drums: "red",
  percussion: "red",
  bass: "orange",
  guitar: "yellow",
  keys: "cyan",
  synth: "cyan",
  vocals: "violet",
  strings: "teal",
  winds: "gold",
  mix: null,
  other: null,
};

/** Winds whose names give them mint instead of the brass gold (woodwinds). */
const WOODWIND_WORDS = ["flute", "fletn", "clarinet", "klarinet"] as const;

/**
 * The order in which free colours are handed out: the eight colours of the original palette
 * first (spread around the wheel, so neighbouring tracks differ clearly), then the others.
 */
export const AUTO_COLOR_ORDER: readonly PaletteColor[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
  "cyan",
  "lime",
  "grape",
  "gold",
  "mint",
  "indigo",
  "brown",
  "slate",
];

/** The colour of an instrument, refined by the name or tag (woodwinds are mint). */
function colorOf(
  instrument: Instrument,
  texts: readonly (string | undefined | null)[],
): PaletteColor | null {
  if (instrument === "winds") {
    const ws = texts.flatMap((t) => (t ? nameWords(t) : []));
    if (ws.some((w) => WOODWIND_WORDS.some((p) => matchesWordPrefix(w, p)))) return "mint";
  }
  return INSTRUMENT_COLORS[instrument];
}

/** The instrument colour a track name or instrument tag suggests, if any. */
export function instrumentColor(...texts: readonly string[]): PaletteColor | null {
  const instrument = guessInstrument(...texts);
  return instrument ? colorOf(instrument, texts) : null;
}

/**
 * The colour of a new track: by instrument (the stored one, else guessed from the name and tag),
 * else the first colour (in {@link AUTO_COLOR_ORDER}) the song's other tracks do not use, else
 * round-robin over the palette by the number of tracks.
 */
export function autoTrackColor(
  track: { name: string; instrumentTag?: string | null; instrument?: Instrument | null },
  song: { usedColors: readonly string[]; trackCount: number },
): PaletteColor {
  const texts = [track.name, track.instrumentTag];
  const instrument = track.instrument ?? guessInstrument(...texts);
  const byInstrument = instrument ? colorOf(instrument, texts) : null;
  if (byInstrument) return byInstrument;
  const used = new Set(song.usedColors);
  const free = AUTO_COLOR_ORDER.find((c) => !used.has(c));
  if (free) return free;
  return AUTO_COLOR_ORDER[song.trackCount % AUTO_COLOR_ORDER.length] ?? "blue";
}
