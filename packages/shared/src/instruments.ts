import { z } from "zod";

/**
 * Track instruments (SPEC §30.3). A track's stored instrument is optional: null means "guessed at
 * read time" from its name and free-text tag ({@link effectiveInstrument}). The effective
 * instrument drives the track colour, "Mute my instrument" and the stretch profile.
 */
export const INSTRUMENTS = [
  "drums",
  "percussion",
  "bass",
  "guitar",
  "keys",
  "vocals",
  "strings",
  "winds",
  "synth",
  "mix",
  "other",
] as const;
export type Instrument = (typeof INSTRUMENTS)[number];
export const InstrumentSchema = z.enum(INSTRUMENTS);

/** Formant base of a vocal track (SPEC §30.3): ≈100 Hz, ≈400 Hz or pitch tracking. */
export const VOICE_RANGES = ["low", "high", "auto"] as const;
export type VoiceRange = (typeof VOICE_RANGES)[number];
export const VoiceRangeSchema = z.enum(VOICE_RANGES);

/**
 * Word prefixes per instrument (lower case, without diacritics; English and Czech); `=` marks a
 * whole word ("tom" but not "tomas"). The first instrument with a matching word wins, so the
 * order matters ("Bass Drum" is drums, "Drum Mix" is drums, "Mix" alone is mix).
 */
export const INSTRUMENT_WORDS: readonly [Instrument, readonly string[]][] = [
  [
    "drums",
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
      "bici",
      "buben",
    ],
  ],
  ["percussion", ["perc"]],
  ["bass", ["bass", "basa", "baskytar"]],
  ["guitar", ["guitar", "gtr", "kytar", "gitar"]],
  ["keys", ["key", "piano", "klavir", "organ", "rhodes", "klaves", "varhan"]],
  ["synth", ["synth"]],
  ["vocals", ["vocal", "voc", "vox", "voice", "sing", "zpev", "hlas", "=bv"]],
  ["strings", ["string", "violin", "viola", "cello", "housl"]],
  [
    "winds",
    [
      "brass",
      "trump",
      "trubk",
      "trombon",
      "pozoun",
      "horn",
      "sax",
      "flute",
      "fletn",
      "clarinet",
      "klarinet",
    ],
  ],
  ["mix", ["mix", "master", "bounce", "rehearsal", "zkouska"]],
];

/** Words of a name or tag: lower case, diacritics removed, split on non-letters and digits. */
export function nameWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 0);
}

/** Whether a word matches a prefix list entry (`=word` matches the whole word only). */
export function matchesWordPrefix(w: string, prefix: string): boolean {
  return prefix.startsWith("=") ? w === prefix.slice(1) : w.startsWith(prefix);
}

/** The instrument a track name or free-text tag suggests, if any. */
export function guessInstrument(
  ...texts: readonly (string | undefined | null)[]
): Instrument | null {
  const ws = texts.flatMap((t) => (t ? nameWords(t) : []));
  for (const [instrument, prefixes] of INSTRUMENT_WORDS) {
    if (ws.some((w) => prefixes.some((p) => matchesWordPrefix(w, p)))) return instrument;
  }
  return null;
}

/** What {@link effectiveInstrument} needs of a track. */
export interface InstrumentTrack {
  name: string;
  instrumentTag?: string | null | undefined;
  instrument?: Instrument | null | undefined;
}

export interface InstrumentOptions {
  /** The track is the only one of its song: unrecognised means "mix" (SPEC §30.3). */
  singleTrack?: boolean;
}

/**
 * A track's instrument (SPEC §30.3): the stored one, else guessed from its name and tag, else
 * `mix` for the only track of a song, else `other`.
 */
export function effectiveInstrument(
  track: InstrumentTrack,
  opts: InstrumentOptions = {},
): Instrument {
  return (
    track.instrument ??
    guessInstrument(track.name, track.instrumentTag) ??
    (opts.singleTrack ? "mix" : "other")
  );
}

/** Whether a category is transposed by default: everything but drums and percussion. */
export function defaultTranspose(i: Instrument): boolean {
  return i !== "drums" && i !== "percussion";
}

/** A track's transpose flag (SPEC §30.3): the stored override, else its category's default. */
export function effectiveTranspose(
  track: InstrumentTrack & { transpose?: boolean | null | undefined },
  opts: InstrumentOptions = {},
): boolean {
  return track.transpose ?? defaultTranspose(effectiveInstrument(track, opts));
}

/** The time-stretch profile of an instrument (SPEC §30.4). */
export type StretchProfile = "tonal" | "voice" | "percussive" | "mix";

export function profileFor(i: Instrument): StretchProfile {
  switch (i) {
    case "vocals":
      return "voice";
    case "drums":
    case "percussion":
      return "percussive";
    case "mix":
      return "mix";
    default:
      return "tonal";
  }
}

/** The formant base frequency of a voice range in Hz; 0 = pitch tracking (auto or unset). */
export function voiceBaseHz(range: VoiceRange | null | undefined): number {
  if (range === "low") return 100;
  if (range === "high") return 400;
  return 0;
}

/**
 * Formants under practice (SPEC §30.3): `auto` = kept in place for vocals, moving with the pitch
 * for everything else; `preserve` = always kept in place; `follow` = always move with the pitch.
 */
export const FORMANT_MODES = ["auto", "preserve", "follow"] as const;
export type FormantMode = (typeof FORMANT_MODES)[number];
export const FormantModeSchema = z.enum(FORMANT_MODES);
/** Formant shift limit in semitones. */
export const FORMANT_SHIFT = 12;
export const FormantShiftSchema = z.number().int().min(-FORMANT_SHIFT).max(FORMANT_SHIFT);

/** A track's band-wide practice settings (null = automatic). */
export interface PracticeTrack extends InstrumentTrack {
  transpose?: boolean | null | undefined;
  voiceRange?: VoiceRange | null | undefined;
  formantMode?: FormantMode | null | undefined;
  formantShift?: number | null | undefined;
}

/** A listener's personal overrides of them (null or missing = the band default). */
export interface PracticeOverride {
  transpose?: boolean | null | undefined;
  formantMode?: FormantMode | null | undefined;
  formantShift?: number | null | undefined;
}

/** How a track is processed under practice (Player and bounce alike, SPEC §30.3–§30.5). */
export interface TrackStretchPolicy {
  /** Follows the transposition. */
  transpose: boolean;
  profile: StretchProfile;
  /** Rough fundamental for formant compensation of vocals (0 = estimate). */
  voiceBaseHz: number;
  /** Formants kept in place while the pitch moves. */
  formant: boolean;
  /** Formant shift in semitones (0 = none). */
  formantShift: number;
}

/**
 * The resolved policy: the personal override, else the track's setting, else the default for its
 * instrument. Every field is a primitive, so policies compare and serialize cheaply.
 */
export function trackStretchPolicy(
  track: PracticeTrack,
  personal: PracticeOverride | null | undefined,
  opts: InstrumentOptions = {},
): TrackStretchPolicy {
  const instrument = effectiveInstrument(track, opts);
  const mode = personal?.formantMode ?? track.formantMode ?? "auto";
  return {
    transpose: personal?.transpose ?? track.transpose ?? defaultTranspose(instrument),
    profile: profileFor(instrument),
    voiceBaseHz: instrument === "vocals" ? voiceBaseHz(track.voiceRange) : 0,
    formant: mode === "auto" ? instrument === "vocals" : mode === "preserve",
    formantShift: personal?.formantShift ?? track.formantShift ?? 0,
  };
}

const NOTE_PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] as const;

/**
 * A key name transposed by `semitones` (SPEC §30.7: "Am" − 2 → "Gm"), or null when it does not
 * start with a note name. The note is a letter A–G (either case; the output is upper case) with
 * an optional accidental (`#`, `b`, `♯`, `♭`); the rest ("m", "min", " major", " moll", …) is
 * kept verbatim. Spelling: flats when the original has a flat, or has no accidental and the shift
 * is downwards; sharps otherwise. Unicode accidentals stay Unicode. German/Czech names are not
 * special-cased: "H" does not parse and "B" is read as B natural.
 */
export function transposeKeyName(key: string, semitones: number): string | null {
  const m = /^\s*([A-Ga-g])([#b♯♭]?)(.*)$/su.exec(key);
  if (!m) return null;
  const [, letter = "", accidental = "", rest = ""] = m;
  const shift = accidental === "#" || accidental === "♯" ? 1 : accidental ? -1 : 0;
  const base = NOTE_PITCH[letter.toUpperCase()] ?? 0;
  const pc = (((base + shift + Math.round(semitones)) % 12) + 12) % 12;
  const flats = accidental === "b" || accidental === "♭" || (!accidental && semitones < 0);
  const unicode = accidental === "♯" || accidental === "♭";
  let name: string = (flats ? FLAT_NAMES : SHARP_NAMES)[pc] ?? "C";
  if (unicode) name = name.replace("#", "♯").replace("b", "♭");
  return name + rest.trimEnd();
}
