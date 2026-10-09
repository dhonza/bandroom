import { z } from "zod";
import { AudioQualitySchema, UploadOptionsSchema } from "./audioQuality";
import { PaletteColorSchema, SongTitleSchema } from "./content";
import { FormantModeSchema, InstrumentSchema, VoiceRangeSchema } from "./instruments";
import { VersionArchivedSchema } from "./lossless";

export const DOWNLOAD_FORMATS = ["original", "flac", "wav", "opus"] as const;
export type DownloadFormat = (typeof DOWNLOAD_FORMATS)[number];
export const DownloadFormatSchema = z.enum(DOWNLOAD_FORMATS);
/** Query of `GET …/track-versions/:id/download` (band and link routes). */
export const DownloadQuerySchema = z.object({ format: DownloadFormatSchema });

export const AssetStatusSchema = z.enum(["uploading", "queued", "processing", "ready", "failed"]);

const OpusRefSchema = z.object({
  hash: z.string(),
  bitrate: z.number(),
  channels: z.number(),
  preSkip: z.number(),
  durationSamples48k: z.number(),
  /** The preset it was encoded with (SPEC §28.2); `null` for older encodes or `opus_low`. */
  quality: AudioQualitySchema.nullable().optional(),
});

/** What the player and UI need to know about one version's audio (SPEC §5.3 variants). */
export const VersionMediaSchema = z.object({
  durationSec: z.number(),
  sampleRate: z.number(),
  channels: z.number(),
  bitDepth: z.number(),
  codec: z.string(),
  lossless: z.boolean(),
  dualMono: z.boolean(),
  integratedLufs: z.number().nullable(),
  truePeakDbtp: z.number().nullable(),
});

export const VersionVariantsSchema = z.object({
  opus: OpusRefSchema.nullable(),
  opusLow: OpusRefSchema.nullable(),
  flac: z
    .object({
      hash: z.string(),
      sampleRate: z.number(),
      bitDepth: z.number(),
      channels: z.number(),
      /** Source frames at `sampleRate`. */
      durationSamples: z.number(),
      nearLossless: z.boolean(),
    })
    .nullable(),
  peaks: z.object({ hash: z.string(), overview: z.array(z.number()) }).nullable(),
  seekIndex: z.object({
    opus: z.string().nullable(),
    opusLow: z.string().nullable(),
    flac: z.string().nullable(),
  }),
});

export const TrackVersionSchema = z.object({
  id: z.string(),
  number: z.number(),
  label: z.string(),
  notes: z.string(),
  /** Timeline position in samples at 48 kHz (SPEC §6.5). */
  offsetSamples: z.number(),
  /** Gain of this version in dB, before the fader and pan (SPEC §25.6). */
  gainDb: z.number(),
  source: z.enum(["upload", "recording", "import", "render"]),
  createdAt: z.number(),
  uploadedBy: z.string().nullable(),
  uploaderName: z.string().nullable(),
  originalFilename: z.string(),
  /** Size of the uploaded file. */
  sizeBytes: z.number(),
  /** Bytes of the stored files of this version (SPEC §28.6); absent on public links. */
  storedBytes: z.number().optional(),
  status: AssetStatusSchema,
  error: z.string().nullable(),
  /** 0–1 while processing. */
  progress: z.number().nullable(),
  media: VersionMediaSchema.nullable(),
  variants: VersionVariantsSchema,
  /** Full-quality files removed (SPEC §26.4); `media.lossless` still describes the source. */
  archived: VersionArchivedSchema.nullable(),
  /** Formats the current user may download (empty if the download policy forbids it). */
  downloads: z.array(DownloadFormatSchema),
});
export type TrackVersion = z.infer<typeof TrackVersionSchema>;

export const TrackSchema = z.object({
  id: z.string(),
  songId: z.string(),
  name: z.string(),
  color: PaletteColorSchema,
  sortOrder: z.number(),
  instrumentTag: z.string(),
  /** Stored instrument (SPEC §30.3); null = guessed from the name and tag. */
  instrument: InstrumentSchema.nullable(),
  /** Transpose override; null = the instrument's default. */
  transpose: z.boolean().nullable(),
  /** Vocals: the formant base; null = auto. */
  voiceRange: VoiceRangeSchema.nullable(),
  /** Formants under practice; null = automatic (SPEC §30.3). */
  formantMode: FormantModeSchema.nullable(),
  /** Formant shift in semitones (band default). */
  formantShift: z.number().int(),
  /** Defaults for everyone's mixer (SPEC §11.3). */
  defaultGainDb: z.number(),
  defaultPan: z.number(),
  defaultMuted: z.boolean(),
  versionCount: z.number(),
  createdBy: z.string().nullable(),
  current: TrackVersionSchema.nullable(),
  /** Bytes of the stored files of all its versions (SPEC §28.6); absent on public links. */
  bytes: z.number().optional(),
});
export type Track = z.infer<typeof TrackSchema>;

/** A version's timeline position bound: 24 h at 48 kHz (SPEC §6.5). */
export const MAX_OFFSET_SAMPLES = 24 * 3600 * 48_000;
/** A version's timeline position in samples at 48 kHz (SPEC §6.5, §9). */
export const OffsetSamplesSchema = z.number().int().min(0).max(MAX_OFFSET_SAMPLES);

/**
 * Audio upload fields of recorded takes (SPEC §9): `source: "recording"` marks a take (it needs
 * the `record` capability) and `offsetSamples` places it on the timeline. Both are optional.
 */
const audioTargetFields = {
  /** Lossy on upload and the Opus preset (SPEC §28.2); absent = keep full quality. */
  options: UploadOptionsSchema.optional(),
  source: z.literal("recording").optional(),
  offsetSamples: OffsetSamplesSchema.optional(),
};

/** Where a finished upload goes (tus `Upload-Metadata` field `target`, JSON; SPEC §5.1). */
export const UploadTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("newTrack"),
    songId: z.string(),
    name: z.string().trim().min(1).max(120),
    ...audioTargetFields,
  }),
  z.object({
    type: z.literal("newVersion"),
    trackId: z.string(),
    ...audioTargetFields,
    /**
     * SHA-256 (lowercase hex) of the file, computed by the client: equal to the current
     * version's original → `DUPLICATE_VERSION`, nothing is uploaded (SPEC §29.5).
     */
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
  /**
   * A new song with the file as its first track (a take recorded on the project page, SPEC §9):
   * needs `song.create` and `upload` on the project.
   */
  z.object({
    type: z.literal("newSong"),
    projectId: z.string(),
    title: SongTitleSchema,
    trackName: z.string().trim().min(1).max(120),
    ...audioTargetFields,
  }),
  z.object({ type: z.literal("projectImage"), projectId: z.string() }),
  /** A new document on the project (SPEC §10, §28.4). */
  z.object({
    type: z.literal("newDocument"),
    projectId: z.string(),
    title: z.string().trim().min(1).max(200).optional(),
  }),
  /** A new version of an existing document ("a new file dropped onto a document", SPEC §10). */
  z.object({ type: z.literal("documentVersion"), documentId: z.string() }),
  /** The instance's branding logo (admins only, SPEC §25.1). */
  z.object({ type: z.literal("instanceLogo") }),
]);
export type UploadTarget = z.infer<typeof UploadTargetSchema>;

export const UploadResultSchema = z.object({
  assetId: z.string(),
  trackId: z.string().nullable(),
  trackVersionId: z.string().nullable(),
  documentId: z.string().nullable().optional(),
  documentVersionId: z.string().nullable().optional(),
  /** The song a `newSong` upload created (SPEC §9: the recorder opens it). */
  songId: z.string().nullable().optional(),
});
export type UploadResult = z.infer<typeof UploadResultSchema>;

/** Server-Sent Event payload (SPEC §18.5). */
export const StreamEventSchema = z.object({
  type: z.string(),
  projectId: z.string().nullable().optional(),
  songId: z.string().nullable().optional(),
  /** User-targeted events (`notification`) reach only this user (SPEC §18.5). */
  userId: z.string().nullable().optional(),
  data: z.record(z.string(), z.unknown()),
});
export type StreamEvent = z.infer<typeof StreamEventSchema>;

/** A version in the stack view (SPEC §11.3). */
export const StackVersionSchema = TrackVersionSchema.extend({ isCurrent: z.boolean() });
export type StackVersion = z.infer<typeof StackVersionSchema>;

/**
 * A song of a project queue (SPEC §6.10, §18.3): `ready` when at least one live track has a
 * current version that is ready to play. The engine queue skips songs that are not ready.
 */
export const QueueItemSchema = z.object({
  songId: z.string(),
  title: z.string(),
  subtitle: z.string(),
  ready: z.boolean(),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

/**
 * A version's gain in dB (SPEC §25.6): no fixed range. Zod 4 numbers are finite, so infinities
 * and NaN are refused.
 */
export const VersionGainSchema = z.number();

export const TrackNameSchema = z.string().trim().min(1).max(120);
