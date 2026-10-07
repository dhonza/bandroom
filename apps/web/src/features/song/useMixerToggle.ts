import type { Song } from "@bandroom/shared";
import { useState } from "react";
import { useListen, type ListenSource } from "../../player/listenStore";
import { saveMixerOpen } from "./mixerMode";
import { openMixer } from "./playerHandoff";

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
  // No Listen source since M21 (SPEC §27): the closed Mixer plays the engine with the default
  // mix until group C makes the engine the only player.
  const src = null as ListenSource | null;
  const mixPlayable = false;
  const [open, setOpen] = useState<boolean | null>(null);

  // Decided once, during render (no flash of the other player).
  let current = open;
  if (current === null && opts.ready) {
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
    turnOff: () => {
      // The engine keeps the song and plays on with the Mixer closed (SPEC §27).
      if (opts.remember) saveMixerOpen(false);
      setOpen(false);
    },
  };
}
