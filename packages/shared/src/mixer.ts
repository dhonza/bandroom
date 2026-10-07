import { z } from "zod";

/** One track in a user's personal mix (SPEC §4.4, §11.3). */
export const MixerTrackStateSchema = z.object({
  gainDb: z.number().min(-120).max(6),
  pan: z.number().min(-1).max(1),
  mute: z.boolean(),
  solo: z.boolean(),
  /** Personal listened version (does not change the song's current version). */
  listenedVersionId: z.string().max(64).nullable().optional(),
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

export const MixerStateSchema = z.object({
  tracks: z
    .record(z.string().max(64), MixerTrackStateSchema)
    .refine((r) => Object.keys(r).length <= 500, { message: "Too many tracks" }),
  /** Missing keys fall back to {@link DEFAULT_CLICK_SETTINGS}. */
  click: ClickSettingsSchema.partial().optional(),
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
