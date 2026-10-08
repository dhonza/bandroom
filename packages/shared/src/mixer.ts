import { z } from "zod";
import { FormantModeSchema, FormantShiftSchema } from "./instruments";

/** One track in a user's personal mix (SPEC §4.4, §11.3). */
export const MixerTrackStateSchema = z.object({
  gainDb: z.number().min(-120).max(6),
  pan: z.number().min(-1).max(1),
  mute: z.boolean(),
  solo: z.boolean(),
  /** Personal listened version (does not change the song's current version). */
  listenedVersionId: z.string().max(64).nullable().optional(),
  /** Personal practice overrides (SPEC §30.3); null or missing = the band default. */
  transpose: z.boolean().nullable().optional(),
  formantMode: FormantModeSchema.nullable().optional(),
  formantShift: FormantShiftSchema.nullable().optional(),
});
export type MixerTrackState = z.infer<typeof MixerTrackStateSchema>;

/** Personal click and count-in settings per song (SPEC §4.4 `click`, §6.7). */
export const ClickSettingsSchema = z.object({
  enabled: z.boolean(),
  gainDb: z.number().min(-60).max(6),
  sound: z.enum(["woodblock", "beep", "hihat"]),
  /** Pulses per counted beat. */
  subdivision: z.union([z.literal(1), z.literal(2), z.literal(4)]),
  accent: z.boolean(),
  /** 6/8, 9/8, 12/8: click every eighth instead of on dotted quarters. */
  compoundEighths: z.boolean(),
  solo: z.boolean(),
  /** "Solo excludes click" (the click is solo-safe otherwise). */
  soloExcludes: z.boolean(),
  countIn: z.boolean(),
  countInBars: z.union([z.literal(1), z.literal(2)]),
  /** Count-in before every loop repeat (with count-in on). */
  countInEveryRepeat: z.boolean(),
});
export type ClickSettings = z.infer<typeof ClickSettingsSchema>;

export const DEFAULT_CLICK_SETTINGS: ClickSettings = {
  enabled: false,
  gainDb: -6,
  sound: "woodblock",
  subdivision: 1,
  accent: true,
  compoundEighths: false,
  solo: false,
  soloExcludes: false,
  countIn: false,
  countInBars: 1,
  countInEveryRepeat: false,
};

/**
 * Personal practice setting per song (SPEC §30.2): playback speed (rate, 1 = original), pitch in
 * semitones and fine tune in cents.
 */
export const PracticeSchema = z.object({
  rate: z.number().min(0.25).max(2),
  semitones: z.number().int().min(-24).max(24),
  cents: z.number().int().min(-100).max(100),
});
export type Practice = z.infer<typeof PracticeSchema>;

export const DEFAULT_PRACTICE: Practice = { rate: 1, semitones: 0, cents: 0 };

export const MixerStateSchema = z.object({
  tracks: z
    .record(z.string().max(64), MixerTrackStateSchema)
    .refine((r) => Object.keys(r).length <= 500, { message: "Too many tracks" }),
  /** Missing keys fall back to {@link DEFAULT_CLICK_SETTINGS}. */
  click: ClickSettingsSchema.partial().optional(),
  /** Missing keys fall back to {@link DEFAULT_PRACTICE}. */
  practice: PracticeSchema.partial().optional(),
});
export type MixerState = z.infer<typeof MixerStateSchema>;

export const MixerSnapshotNameSchema = z.string().trim().min(1).max(80);

export const MixerSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: MixerStateSchema,
  createdAt: z.number(),
});
export type MixerSnapshot = z.infer<typeof MixerSnapshotSchema>;

/**
 * Tracks the mix leaves silent (SPEC §6.6): muted, or not soloed while another track (or the
 * click, SPEC §6.7) is. The engine applies the same rule to its tracks, the timeline draws these
 * lanes faintly, and the bounce leaves them out (SPEC §5.5). Sorted, so it works as a cheap change
 * key (fader moves do not change it).
 */
export function dimmedTrackIds(mix: Pick<MixerState, "tracks" | "click">): string[] {
  const tracks = Object.entries(mix.tracks);
  const anySolo = tracks.some(([, s]) => s.solo) || mix.click?.solo === true;
  return tracks
    .filter(([, s]) => s.mute || (anySolo && !s.solo))
    .map(([id]) => id)
    .sort();
}

/** The full click settings of a mix: missing keys from {@link DEFAULT_CLICK_SETTINGS}. */
export function clickSettingsOf(mix: Pick<MixerState, "click">): ClickSettings {
  return { ...DEFAULT_CLICK_SETTINGS, ...mix.click };
}

/** The full practice setting of a mix: missing keys from {@link DEFAULT_PRACTICE}. */
export function practiceOf(mix: Pick<MixerState, "practice">): Practice {
  return { ...DEFAULT_PRACTICE, ...mix.practice };
}

/** Whether a practice setting changes nothing (original speed and pitch). */
export function isNeutralPractice(p: Practice): boolean {
  return p.rate === 1 && p.semitones === 0 && p.cents === 0;
}

/**
 * Whether the click sounds in the Player (SPEC §6.6–§6.7): on (not muted in its Mixer lane), and
 * not silenced by a soloed track while "solo excludes click" is on, unless it is soloed itself.
 */
export function clickAudible(mix: Pick<MixerState, "tracks" | "click">): boolean {
  const c = clickSettingsOf(mix);
  const trackSolo = Object.values(mix.tracks).some((s) => s.solo);
  return c.enabled && !(c.soloExcludes && trackSolo && !c.solo);
}
