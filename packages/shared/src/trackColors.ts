import type { PaletteColor } from "./content";

/**
 * Colours for new tracks (SPEC §25.10): by instrument when the name or instrument tag tells it,
 * else the first palette colour not used in the song yet, else round-robin by track count.
 */

/**
 * Word prefixes per instrument colour (lower case, without diacritics; English and Czech); `=`
 * marks a whole word ("tom" but not "tomas").
 */
const INSTRUMENT_WORDS: readonly [PaletteColor, readonly string[]][] = [
  [
    "red",
    [
      "drum",
      "kick",
      "snare",
      "hihat",
      "=hat",
      "=tom",
      "=toms",
      "overhead",
      "cymbal",
      "perc",
      "bici",
      "buben",
    ],
  ],
  ["orange", ["bass", "basa", "baskytar"]],
  ["yellow", ["guitar", "gtr", "kytar", "gitar"]],
  ["cyan", ["key", "piano", "klavir", "synth", "organ", "rhodes", "klaves", "varhan"]],
  ["violet", ["vocal", "voc", "vox", "voice", "sing", "zpev", "hlas", "=bv"]],
  ["teal", ["string", "violin", "viola", "cello", "housl"]],
  ["gold", ["brass", "trump", "trubk", "trombon", "pozoun", "horn", "sax"]],
  ["mint", ["flute", "fletn", "clarinet", "klarinet"]],
];

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

/** Words of a name or tag: lower case, diacritics removed, split on non-letters and digits. */
function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 0);
}

/** The instrument colour a track name or instrument tag suggests, if any. */
export function instrumentColor(...texts: readonly string[]): PaletteColor | null {
  const ws = texts.flatMap(words);
  for (const [color, prefixes] of INSTRUMENT_WORDS) {
    const hit = (w: string) =>
      prefixes.some((p) => (p.startsWith("=") ? w === p.slice(1) : w.startsWith(p)));
    if (ws.some(hit)) return color;
  }
  return null;
}

/**
 * The colour of a new track: by instrument, else the first colour (in {@link AUTO_COLOR_ORDER})
 * the song's other tracks do not use, else round-robin over the palette by the number of tracks.
 */
export function autoTrackColor(
  track: { name: string; instrumentTag?: string },
  song: { usedColors: readonly string[]; trackCount: number },
): PaletteColor {
  const byInstrument = instrumentColor(track.name, track.instrumentTag ?? "");
  if (byInstrument) return byInstrument;
  const used = new Set(song.usedColors);
  const free = AUTO_COLOR_ORDER.find((c) => !used.has(c));
  if (free) return free;
  return AUTO_COLOR_ORDER[song.trackCount % AUTO_COLOR_ORDER.length] ?? "blue";
}
