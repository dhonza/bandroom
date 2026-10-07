import { z } from "zod";
import { ProjectNameSchema, SongTitleSchema } from "./content";
import { sameLength } from "./importPlan";
import { TrackNameSchema } from "./tracks";
import { BATCH_MAX_ITEMS } from "./trash";

// Make multitrack song, copy and move (SPEC §26.5, §26.6).

/** A name helper result shorter than this falls back to the first song's name. */
export const MULTITRACK_NAME_MIN = 3;

/** Separators trimmed from both ends of a suggested name. */
const EDGE = /^[\s\-–—_.,:;|/\\()[\]{}#~+]+|[\s\-–—_.,:;|/\\()[\]{}#~+]+$/g;

const trimEdges = (s: string) => s.replace(EDGE, "").trim();
const WORD = /[\p{L}\p{N}]/u;

/**
 * `name.slice(start, end)` without a word cut in half at either edge ("Bas|s – Night" → "–
 * Night"), so a shared last letter does not stick to the name.
 */
function wholeWords(name: string, start: number, end: number): string {
  let s = start;
  let e = end;
  if (s > 0 && WORD.test(name.charAt(s - 1))) while (s < e && WORD.test(name.charAt(s))) s++;
  if (e < name.length && WORD.test(name.charAt(e)))
    while (e > s && WORD.test(name.charAt(e - 1))) e--;
  return name.slice(s, e);
}

/**
 * The name suggested for a new multitrack song (SPEC §26.5): the longest substring all source
 * names share (case-insensitive, without words cut in half, trimmed of separators and spaces),
 * when it has at least
 * {@link MULTITRACK_NAME_MIN} characters; otherwise the first name. `names[0]` is the first source
 * song in selection order.
 */
export function suggestMultitrackName(names: readonly string[]): string {
  const first = names[0]?.trim() ?? "";
  const distinct = [...new Map(names.map((n) => [n.trim().toLowerCase(), n.trim()])).values()];
  if (distinct.length <= 1) return first;
  // Candidates come from the shortest name; the others only need to contain them.
  const shortest = distinct.reduce((a, b) => (b.length < a.length ? b : a));
  const others = distinct.filter((n) => n !== shortest).map((n) => n.toLowerCase());
  const lower = shortest.toLowerCase();
  for (let len = shortest.length; len >= MULTITRACK_NAME_MIN; len--) {
    for (let start = 0; start + len <= shortest.length; start++) {
      const sub = lower.slice(start, start + len);
      if (!others.every((o) => o.includes(sub))) continue;
      const name = trimEdges(wholeWords(shortest, start, start + len));
      if (name.length >= MULTITRACK_NAME_MIN) return name;
    }
  }
  return first;
}

/**
 * Whether the tracks of a multitrack song differ in length (SPEC §26.5): the same tolerance as
 * the importer used to require (0.5 s, or 0.5 % of long recordings). Only a warning; unknown
 * lengths are left out.
 */
export function lengthsDiffer(durations: readonly (number | null)[]): boolean {
  const known = durations.filter((d): d is number => d !== null && d > 0);
  if (known.length < 2) return false;
  return !sameLength(Math.min(...known), Math.max(...known));
}

/** Longest track name (the same limit as {@link TrackNameSchema}). */
const TRACK_NAME_MAX = 120;

/** A source track of a multitrack song, as far as its name and role in the new song go. */
export interface MultitrackTrackSource {
  name: string;
  role: "track" | "mix";
  songId: string;
  songTitle: string;
}

/**
 * Name and role of each track in a new multitrack song (SPEC §26.5), in the order given. A source
 * song that brings exactly one track, a mix (a loose file dropped on a project becomes a song with
 * one "Mix" track), gives that track its song title as the name, and the track becomes a normal
 * track: audible, part of the automatic mix and not muted by default. Nothing changes when the new
 * song would hold one track only.
 */
export function multitrackTrackNames(
  sources: readonly MultitrackTrackSource[],
): { name: string; role: "track" | "mix" }[] {
  const perSong = new Map<string, number>();
  for (const s of sources) perSong.set(s.songId, (perSong.get(s.songId) ?? 0) + 1);
  return sources.map((s) => multitrackTrackName(s, perSong.get(s.songId) ?? 0, sources.length));
}

/**
 * {@link multitrackTrackNames} for one track: `fromSong` tracks come from its song, `total` tracks
 * make up the new song.
 */
export function multitrackTrackName(
  s: MultitrackTrackSource,
  fromSong: number,
  total: number,
): { name: string; role: "track" | "mix" } {
  const title = s.songTitle.trim().slice(0, TRACK_NAME_MAX).trim();
  if (total > 1 && fromSong === 1 && s.role === "mix" && title.length > 0)
    return { name: title, role: "track" };
  return { name: s.name, role: s.role };
}

const Id = z.string().min(1).max(64);
const Ids = z.array(Id).max(BATCH_MAX_ITEMS);

/** Where copied or moved items go: an existing project, or a new one (SPEC §26.6). */
const TargetFields = {
  targetProjectId: Id.optional(),
  /** Creates a project with this name; the user becomes its manager (`project.create`). */
  newProject: z.object({ name: ProjectNameSchema }).optional(),
};

const count = (b: { songs?: string[] | undefined; tracks?: string[] | undefined }) =>
  (b.songs?.length ?? 0) + (b.tracks?.length ?? 0);
const inRange = (b: { songs?: string[] | undefined; tracks?: string[] | undefined }) =>
  count(b) >= 1 && count(b) <= BATCH_MAX_ITEMS;
const oneTarget = (b: { targetProjectId?: string | undefined; newProject?: unknown }) =>
  (b.targetProjectId !== undefined) !== (b.newProject !== undefined);
const RANGE_MSG = { message: `between 1 and ${String(BATCH_MAX_ITEMS)} items` };
const TARGET_MSG = { message: "either targetProjectId or newProject" };

/** Songs (standing for all their tracks) and tracks for a multitrack song. */
export const MultitrackItemsSchema = z
  .object({ songs: Ids.optional(), tracks: Ids.optional() })
  .refine(inRange, RANGE_MSG);
export type MultitrackItems = z.infer<typeof MultitrackItemsSchema>;

/**
 * `POST /batch/make-multitrack` (tracks move) and `/batch/copy-tracks` (tracks are copied): the
 * tracks become one new song named `name` in the target project.
 */
export const MakeMultitrackSchema = z
  .object({
    songs: Ids.optional(),
    tracks: Ids.optional(),
    name: SongTitleSchema,
    /** Names chosen in the dialog per source track id; they win over the computed defaults. */
    names: z.record(Id, TrackNameSchema).optional(),
    ...TargetFields,
  })
  .refine(inRange, RANGE_MSG)
  .refine(oneTarget, TARGET_MSG);
export type MakeMultitrack = z.infer<typeof MakeMultitrackSchema>;

/** `POST /batch/copy-songs` and `/batch/move-songs`. */
export const SongsToProjectSchema = z
  .object({ songs: Ids.min(1), ...TargetFields })
  .refine(oneTarget, TARGET_MSG);
export type SongsToProject = z.infer<typeof SongsToProjectSchema>;

/** A source track in the make-multitrack dialog. */
export const MultitrackTrackSchema = z.object({
  id: z.string(),
  name: z.string(),
  songId: z.string(),
  songTitle: z.string(),
  /** Length of the current version (null while unknown). */
  durationSec: z.number().nullable(),
});

/** What the dialog shows before making a multitrack song (nothing is changed). */
export const MultitrackPreviewSchema = z.object({
  /** In selection order: the tracks of selected songs, then selected tracks. */
  tracks: z.array(MultitrackTrackSchema),
  /** Source songs in selection order; `emptied` = all its tracks are selected (moved → Trash). */
  songs: z.array(z.object({ id: z.string(), title: z.string(), emptied: z.boolean() })),
  suggestedName: z.string(),
  lengthsDiffer: z.boolean(),
});
export type MultitrackPreview = z.infer<typeof MultitrackPreviewSchema>;

export const BatchTransferResultSchema = z.object({
  ok: z.literal(true),
  batchId: z.string(),
  /** Songs created, copied or moved. */
  count: z.number().int(),
  /** The target project (new or existing). */
  projectId: z.string(),
  /** The new (or moved) songs, in order. */
  songIds: z.array(z.string()),
});
export type BatchTransferResult = z.infer<typeof BatchTransferResultSchema>;
