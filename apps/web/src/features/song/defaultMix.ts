import type { Song, Track } from "@bandroom/shared";
import { useEffect, useRef, useState } from "react";
import { useRehearse } from "../../rehearse/controller";
import { useProjectQueue } from "../../player/useProjectQueue";
import type { MixerToggle } from "./useMixerToggle";
import { closeMixer } from "./playerHandoff";

/** Tracks whose current version can play in the engine. */
export function readyTrackCount(tracks: readonly Track[]): number {
  return tracks.filter((t) => t.current?.status === "ready" && t.current.variants.opus !== null)
    .length;
}

/**
 * Whether the closed Mixer plays the tracks with the default mix (SPEC §25.5): the song has
 * tracks ready to play but its mix is not ready yet. Once the mix is ready the player switches to it, but not
 * in the middle of playback: the default mix keeps playing until it is paused.
 */
export function shouldPlayDefaultMix(f: {
  open: boolean | null;
  /** Tracks ready to play (without any, the mix player shows its waiting state). */
  trackCount: number;
  mixPlayable: boolean;
  /** The default mix was playing in the previous render. */
  held: boolean;
  enginePlaying: boolean;
}): boolean {
  if (f.open !== false || f.trackCount === 0) return false;
  return !f.mixPlayable || (f.held && f.enginePlaying);
}

/**
 * The closed Mixer's default-mix player state. When it hands over to the rendered mix, the mix
 * player is cued where the engine stopped.
 */
export function useDefaultMix(
  song: Song,
  mixer: Pick<MixerToggle, "open" | "mixPlayable" | "src">,
  tracks: readonly Track[],
): boolean {
  const queue = useProjectQueue(song.project);
  const enginePlaying = useRehearse(
    (s) => s.songId === song.id && (s.status === "playing" || s.status === "buffering"),
  );
  const [held, setHeld] = useState(false);
  const fallback = shouldPlayDefaultMix({
    open: mixer.open,
    trackCount: readyTrackCount(tracks),
    mixPlayable: mixer.mixPlayable,
    held,
    enginePlaying,
  });
  if (fallback !== held) setHeld(fallback);

  // The default mix stopped (paused, and the mix is ready): cue the mix player there.
  const was = useRef(fallback);
  const { open, src, mixPlayable } = mixer;
  useEffect(() => {
    const before = was.current;
    was.current = fallback;
    if (before && !fallback && open === false && src && mixPlayable) {
      closeMixer(song, src, queue.data, { play: false });
    }
  }, [fallback, open, src, mixPlayable, song, queue.data]);
  return fallback;
}
