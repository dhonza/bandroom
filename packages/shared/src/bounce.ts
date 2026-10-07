import { z } from "zod";
import { dbToGain } from "./audio/pan";
import { SongTitleSchema } from "./content";
import { dimmedTrackIds, MixerStateSchema, type MixerState, type MixerTrackState } from "./mixer";

/**
 * Most tracks one bounce renders (SPEC §5.5): ffmpeg opens every input at once, and the worker
 * has to stay inside the 1 GB budget (SPEC §19.6).
 */
export const BOUNCE_MAX_TRACKS = 64;

/**
 * `POST /songs/:id/bounce` (SPEC §5.5): the personal mix and the version each track plays in the
 * Player (track id → version id). Tracks without an entry are not in the bounce. The options
 * (owner decisions 2026-10-07) default to what an older client got: tempo map and markers copied,
 * no click. With `includeClick` the click is rendered with `mix.click` (its volume and sound) and
 * counts toward the {@link BOUNCE_MAX_TRACKS} inputs.
 */
export const BounceRequestSchema = z
  .object({
    title: SongTitleSchema,
    mix: MixerStateSchema,
    versions: z.record(z.string().min(1).max(64), z.string().min(1).max(64)).refine(
      (r) => {
        const n = Object.keys(r).length;
        return n >= 1 && n <= BOUNCE_MAX_TRACKS;
      },
      { message: `1 to ${BOUNCE_MAX_TRACKS} tracks` },
    ),
    /** Copy the source's tempo map into the new song. */
    copyTempo: z.boolean().default(true),
    /** Copy the source's markers and sections. */
    copyMarkers: z.boolean().default(true),
    /** Render the click track (needs a tempo map). */
    includeClick: z.boolean().default(false),
  })
  .refine((r) => Object.keys(r.versions).length + (r.includeClick ? 1 : 0) <= BOUNCE_MAX_TRACKS, {
    message: `At most ${BOUNCE_MAX_TRACKS} inputs, the click included`,
    path: ["versions"],
  });
export type BounceRequest = z.infer<typeof BounceRequestSchema>;

/** One track as the bounce renders it: its version and the personal fader and pan. */
export interface BounceTrack {
  trackId: string;
  versionId: string;
  /** Fader in dB (the version's own gain is applied on top, SPEC §25.6). */
  gainDb: number;
  pan: number;
}

/**
 * The tracks a bounce renders (SPEC §5.5), with the engine's rules (SPEC §6.6): a track missing
 * from the personal mix plays its default mix (`defaults`); muted tracks, and unsoloed ones while
 * another bounced track (or the click, when the bounce includes it: `clickSolo`) is soloed, are
 * left out ({@link dimmedTrackIds} over the bounced tracks, as the engine sees only the tracks it
 * plays); a fader at the bottom is silence.
 */
export function bounceTracks(
  versions: Readonly<Record<string, string>>,
  mix: Pick<MixerState, "tracks">,
  defaults: (trackId: string) => MixerTrackState | undefined,
  clickSolo = false,
): BounceTrack[] {
  const states = new Map<string, MixerTrackState>();
  for (const id of Object.keys(versions)) {
    const s = mix.tracks[id] ?? defaults(id);
    if (s) states.set(id, s);
  }
  const dimmed = new Set(
    dimmedTrackIds({ tracks: Object.fromEntries(states), click: { solo: clickSolo } }),
  );
  const out: BounceTrack[] = [];
  for (const [trackId, versionId] of Object.entries(versions)) {
    const s = states.get(trackId);
    if (!s || dimmed.has(trackId) || dbToGain(s.gainDb) === 0) continue;
    out.push({ trackId, versionId, gainDb: s.gainDb, pan: s.pan });
  }
  return out;
}
