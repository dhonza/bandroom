import { z } from "zod";
import { clampFades, clipEnd, headOf, sortClips, tailOf } from "./clips";
import type { TrackClips } from "./ops";
import { EDIT_SAMPLE_RATE, FrameSchema, type EditClip, type EditFades } from "./schema";

/**
 * Split into songs (SPEC §24.9): the candidate ranges on the edited timeline and the naming of
 * the new songs and their tracks. Pure; the review dialog and the server use the same functions.
 */

export const EDIT_SONG_RANGE_SOURCES = ["section", "marker", "start"] as const;

/** A candidate range of the edited timeline (frames at 48 kHz). */
export const EditSongRangeSchema = z.object({
  /** The section or marker id; `start` for the range from 0:00 to the first marker. */
  id: z.string().min(1).max(64),
  /** The section or marker name; empty for the range from 0:00. */
  name: z.string().max(60),
  startFrame: FrameSchema,
  endFrame: FrameSchema,
  source: z.enum(EDIT_SONG_RANGE_SOURCES),
});
export type EditSongRange = z.infer<typeof EditSongRangeSchema>;

/** Id of the range from 0:00 to the first marker. */
export const START_RANGE_ID = "start";

/** Naming options of the new songs (SPEC §24.9, owner). */
export const EditSongNamingSchema = z.object({
  /** Song title: the section/marker name, or "<session song> – <name>". */
  title: z.enum(["name", "sessionAndName"]).default("name"),
  /** "01 Intro": numbered in timeline order. */
  numbered: z.boolean().default(false),
  /** Tracks keep their names, or get "<name> – <track>". */
  trackNames: z.enum(["keep", "rangePrefix"]).default("keep"),
});
export type EditSongNaming = z.infer<typeof EditSongNamingSchema>;
export const DEFAULT_EDIT_SONG_NAMING: EditSongNaming = {
  title: "name",
  numbered: false,
  trackNames: "keep",
};

/** A marker or section as the ranges need it (already on the edited timeline). */
export interface RangeMarker {
  id: string;
  type: "marker" | "section";
  name: string;
  startSec: number;
  endSec: number | null;
  lane: number;
}

const toFrame = (sec: number) => Math.round(sec * EDIT_SAMPLE_RATE);

function hasAudio(tracks: readonly TrackClips[], start: number, end: number): boolean {
  return tracks.some((t) => t.clips.some((c) => c.startFrame < end && clipEnd(c) > start));
}

/**
 * The candidate ranges (SPEC §24.9): the sections of lane 0, or the ranges between consecutive
 * markers (the last runs to the end; `start` covers 0:00 up to the first marker). Ranges are
 * clipped to the song end; ranges without audio on any track are left out.
 */
export function editSongRanges(
  items: readonly RangeMarker[],
  tracks: readonly TrackClips[],
  endFrame: number,
): { sections: EditSongRange[]; markers: EditSongRange[] } {
  const keep = (r: EditSongRange) =>
    r.endFrame > r.startFrame && hasAudio(tracks, r.startFrame, r.endFrame);
  const sections = items
    .filter((m) => m.type === "section" && m.lane === 0 && m.endSec !== null)
    .map((m): EditSongRange => ({
      id: m.id,
      name: m.name,
      startFrame: Math.min(toFrame(m.startSec), endFrame),
      endFrame: Math.min(toFrame(m.endSec as number), endFrame),
      source: "section",
    }))
    .sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame)
    .filter(keep);
  const points = items
    .filter((m) => m.type === "marker")
    .map((m) => ({ id: m.id, name: m.name, frame: toFrame(m.startSec) }))
    .filter((m) => m.frame < endFrame)
    .sort((a, b) => a.frame - b.frame);
  const markers: EditSongRange[] = [];
  const first = points[0];
  if (first && first.frame > 0)
    markers.push({
      id: START_RANGE_ID,
      name: "",
      startFrame: 0,
      endFrame: first.frame,
      source: "start",
    });
  points.forEach((m, i) => {
    markers.push({
      id: m.id,
      name: m.name,
      startFrame: m.frame,
      endFrame: points[i + 1]?.frame ?? endFrame,
      source: "marker",
    });
  });
  return { sections, markers: markers.filter(keep) };
}

/**
 * The default title of the new song of a range (SPEC §24.9): the range name, or "<session song>
 * – <name>", optionally numbered ("01 Intro"; at least two digits). The range from 0:00 (no
 * name) is titled after the session's song.
 */
export function editSongTitle(
  range: Pick<EditSongRange, "name">,
  index: number,
  total: number,
  naming: EditSongNaming,
  sessionTitle: string,
): string {
  const name = range.name.trim();
  const base =
    name === ""
      ? sessionTitle
      : naming.title === "sessionAndName"
        ? `${sessionTitle} – ${name}`
        : name;
  const digits = Math.max(2, String(total).length);
  const title = naming.numbered ? `${String(index + 1).padStart(digits, "0")} ${base}` : base;
  return title.trim().slice(0, 200) || sessionTitle.slice(0, 200);
}

/** A track's name in the new song: kept, or "<range name> – <track>" (SPEC §24.9). */
export function editSongTrackName(
  range: Pick<EditSongRange, "name">,
  trackName: string,
  naming: EditSongNaming,
): string {
  const name = range.name.trim();
  if (naming.trackNames === "keep" || name === "") return trackName;
  return `${name} – ${trackName}`.slice(0, 120);
}

/**
 * A track's clips cut to `[start, end)` and moved so the range starts at 0 (a new song of split
 * into songs, SPEC §24.9). Clips cut at a range edge get the session's fade-in / fade-out there
 * (like a cut at the song start or end, SPEC §24.3).
 */
export function clipsInRange(
  clips: readonly EditClip[],
  start: number,
  end: number,
  fades: Pick<EditFades, "fadeIn" | "fadeOut">,
): EditClip[] {
  const out: EditClip[] = [];
  for (const c of clips) {
    if (clipEnd(c) <= start || c.startFrame >= end) continue;
    let x = c;
    if (x.startFrame < start)
      x = { ...tailOf(x, start, x.id), fadeInFrames: fades.fadeIn, fadeInShape: "equalPower" };
    if (clipEnd(x) > end)
      x = { ...headOf(x, end, x.id), fadeOutFrames: fades.fadeOut, fadeOutShape: "equalPower" };
    out.push(clampFades({ ...x, startFrame: x.startFrame - start }));
  }
  return sortClips(out);
}
