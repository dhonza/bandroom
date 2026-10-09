import { z } from "zod";

/**
 * Edit mode data model (SPEC §24.2). Everything is in frames at 48 kHz; seconds appear only in the
 * UI. Markers and comments convert with `Math.round(sec × 48000)` (SPEC §24.1).
 */

export const EDIT_SAMPLE_RATE = 48_000;
/** Operations kept per session; older ones are folded into the base (SPEC §24.7). */
export const MAX_EDIT_OPS = 2000;
export const MAX_CLIPS_PER_TRACK = 500;
/** Clips playing at once at any frame of one track (decode cursors, SPEC §24.5). */
export const MAX_OVERLAPPING_CLIPS = 4;
export const MAX_EDIT_TRACKS = 64;
const MAX_FADE = 480_000;

export const FrameSchema = z.number().int().min(0);
export const FrameRangeSchema = z
  .object({ start: FrameSchema, end: FrameSchema })
  .refine((r) => r.end > r.start, { message: "A range ends after it starts", path: ["end"] });
export type FrameRange = z.infer<typeof FrameRangeSchema>;

const TrackIdsSchema = z.array(z.string().min(1)).min(1).max(MAX_EDIT_TRACKS);

/** ms in the UI, frames here; 0 = hard edge. Each op keeps the values current when it ran. */
export const EditFadesSchema = z.object({
  fadeIn: z.number().int().min(0).max(MAX_FADE).default(480),
  fadeOut: z.number().int().min(0).max(MAX_FADE).default(480),
  crossfade: z.number().int().min(0).max(MAX_FADE).default(480),
});
export type EditFades = z.infer<typeof EditFadesSchema>;
export const DEFAULT_EDIT_FADES: EditFades = { fadeIn: 480, fadeOut: 480, crossfade: 480 };

export const FADE_SHAPES = ["linear", "equalPower"] as const;
export const FadeShapeSchema = z.enum(FADE_SHAPES);
export type FadeShape = z.infer<typeof FadeShapeSchema>;

export const EditClipSchema = z.object({
  /** Stable across ops; split halves get new ids derived from the op id. */
  id: z.string().min(1),
  sourceVersionId: z.string().min(1),
  /** 48 kHz frames into the source version. */
  sourceStartFrame: FrameSchema,
  /** Timeline position. */
  startFrame: FrameSchema,
  lengthFrames: z.number().int().min(1),
  /** The whole gain of the clip; the initial clip carries the version's gain (§24.2). */
  gainDb: z.number().min(-60).max(24).default(0),
  fadeInFrames: FrameSchema,
  fadeOutFrames: FrameSchema,
  fadeInShape: FadeShapeSchema.default("equalPower"),
  fadeOutShape: FadeShapeSchema.default("equalPower"),
});
export type EditClip = z.infer<typeof EditClipSchema>;

export const OVERLAP_MODES = ["mix", "overwrite", "block"] as const;
export const OverlapModeSchema = z.enum(OVERLAP_MODES);
export type OverlapMode = z.infer<typeof OverlapModeSchema>;

/** Which timeline items follow an op (Edit options, all on by default; SPEC §24.4). */
export const TimelineFollowSchema = z.object({
  markers: z.boolean(),
  sections: z.boolean(),
  comments: z.boolean(),
  tempo: z.boolean(),
});
export type TimelineFollow = z.infer<typeof TimelineFollowSchema>;
export const FOLLOW_ALL: TimelineFollow = {
  markers: true,
  sections: true,
  comments: true,
  tempo: true,
};

/** Snapping modes of the timeline (SPEC §7.5), the same values as the web's marker toolbar. */
export const SNAP_MODES = ["off", "markers", "bar", "beat", "half", "quarter"] as const;
export const SnapModeSchema = z.enum(SNAP_MODES);
export type SnapMode = z.infer<typeof SnapModeSchema>;

export const EditOptionsSchema = z.object({
  fades: EditFadesSchema,
  overlap: OverlapModeSchema.default("mix"),
  timeline: TimelineFollowSchema,
  snap: SnapModeSchema,
});
export type EditOptions = z.infer<typeof EditOptionsSchema>;

/** Fields every operation carries (SPEC §24.2). */
const opCommon = {
  id: z.uuid(),
  /** When the op was made (epoch ms). */
  at: z.number(),
  userId: z.string(),
  timeline: TimelineFollowSchema,
};

/**
 * Split positions are `frames` (the spec's `at` is the op's timestamp). Split at markers carries
 * the resolved positions too, so a replay never needs the markers.
 */
export const EditOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("split"),
    frames: z.array(FrameSchema).min(1).max(2),
    tracks: TrackIdsSchema,
    ...opCommon,
  }),
  z.object({
    type: z.literal("splitAtMarkers"),
    markerIds: z.array(z.string()).max(500),
    frames: z.array(FrameSchema).min(1).max(1000),
    tracks: TrackIdsSchema,
    ...opCommon,
  }),
  z.object({
    type: z.literal("cut"),
    range: FrameRangeSchema,
    tracks: TrackIdsSchema,
    fades: EditFadesSchema,
    ...opCommon,
  }),
  z.object({
    type: z.literal("silence"),
    range: FrameRangeSchema,
    tracks: TrackIdsSchema,
    fades: EditFadesSchema,
    ...opCommon,
  }),
  z.object({
    type: z.literal("gain"),
    range: FrameRangeSchema,
    tracks: TrackIdsSchema,
    gainDb: z.number().min(-60).max(24),
    fades: EditFadesSchema,
    ...opCommon,
  }),
  z.object({
    type: z.literal("move"),
    clipIds: z.array(z.string()).min(1).max(MAX_CLIPS_PER_TRACK),
    deltaFrames: z.number().int(),
    /** All moved clips land on this track; null keeps each on its own. */
    toTrackId: z.string().nullable(),
    overlap: OverlapModeSchema,
    fades: EditFadesSchema,
    ...opCommon,
  }),
  z.object({
    type: z.literal("trim"),
    clipId: z.string(),
    edge: z.enum(["start", "end"]),
    deltaFrames: z.number().int(),
    overlap: OverlapModeSchema,
    fades: EditFadesSchema,
    ...opCommon,
  }),
]);
export type EditOp = z.infer<typeof EditOpSchema>;
export type EditOpType = EditOp["type"];

/**
 * A timeline change folded into the base with its ops (SPEC §24.7): a cut of `[start, end)`, or
 * a move of `[start, end)` by `delta` on all tracks (SPEC §24.4).
 */
export const RemapStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cut"),
    start: FrameSchema,
    end: FrameSchema,
    timeline: TimelineFollowSchema,
  }),
  z.object({
    kind: z.literal("move"),
    start: FrameSchema,
    end: FrameSchema,
    delta: z.number().int(),
    timeline: TimelineFollowSchema,
  }),
]);
export type RemapStep = z.infer<typeof RemapStepSchema>;

export const EditBaseTrackSchema = z.object({
  trackId: z.string().min(1),
  versionId: z.string().min(1),
  offsetSamples: z.number().int(),
  gainDb: z.number(),
  /** Length of the version at 48 kHz. */
  lengthFrames: z.number().int().min(1),
  /** The track's clip when the session started (null when the version lies before 0). */
  clip: EditClipSchema.nullable(),
  /** Clips after the folded ops (SPEC §24.7); absent until something is folded. */
  folded: z.array(EditClipSchema).max(MAX_CLIPS_PER_TRACK).optional(),
});
export type EditBaseTrack = z.infer<typeof EditBaseTrackSchema>;

export const EditBaseSchema = z.object({
  tracks: z.array(EditBaseTrackSchema).min(1).max(MAX_EDIT_TRACKS),
  /** Timeline changes of the folded ops, oldest first. */
  remap: z
    .array(RemapStepSchema)
    .max(MAX_EDIT_OPS * 10)
    .default([]),
  /** Number of ops folded so far. */
  foldedOps: z.number().int().min(0).default(0),
});
export type EditBase = z.infer<typeof EditBaseSchema>;
