import { getSongListen, type ListenSource, type Song } from "@bandroom/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useListen } from "../../player/listenStore";
import { useProjectQueue } from "../../player/useProjectQueue";
import { songKeys } from "../library/queries";
import { saveMixerOpen } from "./mixerMode";
import { closeMixer, openMixer } from "./playerHandoff";

export interface MixerToggle {
  /** Null until decided (the tracks and the mix source have loaded). */
  open: boolean | null;
  src: ListenSource | null;
  /**
   * The song's mix can play through `<audio>`. Without it the closed Mixer plays the tracks with
   * the default mix (SPEC §25.5).
   */
  mixPlayable: boolean;
  turnOn: () => void;
  turnOff: (opts?: { play?: boolean }) => void;
}

/**
 * State of the song player's Mixer toggle and the hand-off between the mix player and the
 * engine. The data the hand-off needs (mix source, project queue) is loaded with the page, so a
 * toggle starts audio inside the tap (iOS).
 */
export function useMixerToggle(
  song: Song,
  opts: {
    /** The tracks have loaded. */
    ready: boolean;
    decide: (facts: { mixPlayable: boolean; listenPlayingThisSong: boolean }) => boolean;
    /** Store the user's toggles on this device (not for link visitors). */
    remember: boolean;
  },
): MixerToggle {
  const queue = useProjectQueue(song.project);
  const listen = useQuery({
    queryKey: songKeys.listen(song.id),
    queryFn: ({ signal }) => api(getSongListen, { params: { id: song.id } }, { signal }),
  });
  const src = listen.data?.listen ?? null;
  const mixPlayable = src?.status === "ready" && src.opus !== null;
  const [open, setOpen] = useState<boolean | null>(null);

  // Decided once, during render (no flash of the other player).
  let current = open;
  if (current === null && opts.ready && !listen.isPending) {
    const s = useListen.getState();
    const playingHere =
      s.queue[s.index]?.songId === song.id && (s.status === "playing" || s.status === "loading");
    current = opts.decide({ mixPlayable, listenPlayingThisSong: playingHere });
    setOpen(current);
  }

  return {
    open: current,
    src,
    mixPlayable,
    turnOn: () => {
      openMixer(song.id);
      if (opts.remember) saveMixerOpen(true);
      setOpen(true);
    },
    turnOff: ({ play } = {}) => {
      // Without a mix the engine keeps the song and plays the default mix (SPEC §25.5).
      if (src && mixPlayable) closeMixer(song, src, queue.data, play === undefined ? {} : { play });
      if (opts.remember) saveMixerOpen(false);
      setOpen(false);
    },
  };
}
