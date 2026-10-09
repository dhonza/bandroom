import { z } from "zod";
import { PaletteColorSchema, type PaletteColor } from "./content";

/** Markers (points) and sections (spans) on a song's timeline (SPEC §7.4). */
export const MARKER_TYPES = ["marker", "section"] as const;
export const MarkerTypeSchema = z.enum(MARKER_TYPES);
export type MarkerType = z.infer<typeof MarkerTypeSchema>;

/** Section name presets with their palette colors, consistent across the app (SPEC §7.4). */
export const SECTION_PRESETS = [
  "intro",
  "verse",
  "prechorus",
  "chorus",
  "bridge",
  "solo",
  "outro",
  "break",
] as const;
export type SectionPreset = (typeof SECTION_PRESETS)[number];
export const SECTION_PRESET_COLORS: Record<SectionPreset, PaletteColor> = {
  intro: "teal",
  verse: "blue",
  prechorus: "violet",
  chorus: "red",
  bridge: "orange",
  solo: "yellow",
  outro: "green",
  break: "pink",
};

export const MarkerNameSchema = z.string().trim().min(1).max(60);
export const MarkerNoteSchema = z.string().trim().max(500);
/** Song positions in seconds; 24 h is far beyond any song and keeps REAL values sane. */
export const MarkerSecSchema = z.number().min(0).max(86_400);

/**
 * `musical` items store beats and follow tempo map changes; the server derives the beats from
 * the times with the song's tempo map (no tempo map: the item stays time-anchored, SPEC §7.4).
 */
export const MarkerAnchorSchema = z.enum(["time", "musical"]);
export type MarkerAnchor = z.infer<typeof MarkerAnchorSchema>;

export const MarkerSchema = z.object({
  id: z.string(),
  songId: z.string(),
  type: MarkerTypeSchema,
  name: z.string(),
  color: PaletteColorSchema,
  note: z.string(),
  startSec: z.number(),
  /** Sections only. */
  endSec: z.number().nullable(),
  /** `musical` items follow the tempo map (SPEC §7.4). */
  anchor: MarkerAnchorSchema,
  startBeat: z.number().nullable(),
  endBeat: z.number().nullable(),
  /** Sections: stacked lane for overlaps (0 = structure lane). Markers: 0. */
  lane: z.number().int().min(0),
  createdBy: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Marker = z.infer<typeof MarkerSchema>;

export const CreateMarkerSchema = z
  .object({
    type: MarkerTypeSchema,
    name: MarkerNameSchema,
    color: PaletteColorSchema,
    note: MarkerNoteSchema.default(""),
    startSec: MarkerSecSchema,
    endSec: MarkerSecSchema.nullable().optional(),
    anchor: MarkerAnchorSchema.optional(),
    /** Client UUID for idempotent replays of the offline outbox (SPEC §13, §18.3). */
    requestId: z.uuid().optional(),
  })
  .refine((m) => (m.type === "section" ? m.endSec != null && m.endSec > m.startSec : true), {
    message: "A section ends after it starts",
    path: ["endSec"],
  });
export type CreateMarker = z.input<typeof CreateMarkerSchema>;

export const UpdateMarkerSchema = z
  .object({
    name: MarkerNameSchema,
    color: PaletteColorSchema,
    note: MarkerNoteSchema,
    startSec: MarkerSecSchema,
    endSec: MarkerSecSchema,
    anchor: MarkerAnchorSchema,
  })
  .partial();
export type UpdateMarker = z.infer<typeof UpdateMarkerSchema>;

/** Converting markers to sections and back (SPEC §7.4 timeline items editor). */
export const MARKER_CONVERT_MAX = 500;
export const ConvertMarkersSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(MARKER_CONVERT_MAX),
  to: MarkerTypeSchema,
  /** Client UUID for idempotent replays (SPEC §18.3). */
  requestId: z.uuid().optional(),
});
export type ConvertMarkers = z.infer<typeof ConvertMarkersSchema>;

/** The fields of an item that a conversion reads. */
export type ConvertibleMarker = Pick<
  Marker,
  "id" | "type" | "name" | "color" | "note" | "startSec" | "endSec" | "anchor"
>;

export interface ConversionPlan {
  /** One new item per converted source, in source time order. */
  creates: {
    sourceId: string;
    item: {
      type: MarkerType;
      name: string;
      color: PaletteColor;
      note: string;
      startSec: number;
      endSec: number | null;
      anchor: MarkerAnchor;
    };
  }[];
  /** Selected ids left as they are: unknown, already of the target type, or zero length. */
  skippedIds: string[];
}

/**
 * What converting the selected items does (pure; the server runs it in one transaction):
 * - to sections: each selected marker spans to the next marker in time among *all* markers of
 *   the song (not only the selected ones); the last one ends at `songEndSec`. Without a known
 *   song end, or when that end is not after the marker, the marker is skipped.
 * - to markers: each selected section becomes a marker at its start.
 * Name, color, note and anchor carry over. `items` are the song's live items.
 */
export function conversionPlan(
  items: readonly ConvertibleMarker[],
  ids: readonly string[],
  to: MarkerType,
  songEndSec: number | null,
): ConversionPlan {
  const byId = new Map(items.map((m) => [m.id, m]));
  const markerTimes = [
    ...new Set(items.filter((m) => m.type === "marker").map((m) => m.startSec)),
  ].sort((a, b) => a - b);
  const creates: ConversionPlan["creates"] = [];
  const skippedIds: string[] = [];
  const sources: ConvertibleMarker[] = [];
  for (const id of new Set(ids)) {
    const m = byId.get(id);
    if (!m || m.type === to) skippedIds.push(id);
    else sources.push(m);
  }
  sources.sort((a, b) => a.startSec - b.startSec);
  for (const m of sources) {
    let endSec: number | null = null;
    if (to === "section") {
      endSec = markerTimes.find((t) => t > m.startSec) ?? songEndSec;
      if (endSec === null || endSec <= m.startSec) {
        skippedIds.push(m.id);
        continue;
      }
    }
    creates.push({
      sourceId: m.id,
      item: {
        type: to,
        name: m.name,
        color: m.color,
        note: m.note,
        startSec: m.startSec,
        endSec,
        anchor: m.anchor,
      },
    });
  }
  return { creates, skippedIds };
}

/**
 * Lanes for overlapping sections (SPEC §7.4): sorted by start (then creation), each section
 * takes the lowest lane that is free at its start, so non-overlapping sections share lane 0.
 */
export function assignLanes(
  sections: readonly { id: string; startSec: number; endSec: number; createdAt?: number }[],
): Map<string, number> {
  const sorted = [...sections].sort(
    (a, b) => a.startSec - b.startSec || (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );
  const laneEnds: number[] = [];
  const out = new Map<string, number>();
  for (const s of sorted) {
    let lane = laneEnds.findIndex((end) => end <= s.startSec);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = s.endSec;
    out.set(s.id, lane);
  }
  return out;
}

/** "What's new" since the user's last visit (SPEC §11.3). */
export const WhatsNewSchema = z.object({
  /** Previous visit; null on the first visit (nothing is listed then). */
  since: z.number().nullable(),
  versions: z.array(
    z.object({
      trackId: z.string(),
      trackName: z.string(),
      versionId: z.string(),
      number: z.number(),
      byName: z.string().nullable(),
      createdAt: z.number(),
    }),
  ),
  markers: z.array(
    z.object({
      id: z.string(),
      type: MarkerTypeSchema,
      name: z.string(),
      startSec: z.number(),
      byName: z.string().nullable(),
    }),
  ),
  commentCount: z.number(),
  /** The earliest new comment (jump target of the banner's comments entry, M8). */
  firstComment: z.object({ id: z.string(), startSec: z.number().nullable() }).nullable(),
});
export type WhatsNew = z.infer<typeof WhatsNewSchema>;
