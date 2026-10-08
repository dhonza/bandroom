import { useState } from "react";

/**
 * Songs whose Mixer is open on this device: a JSON array of song ids, newest first. Songs not in
 * the list open with the Player (Mixer closed).
 */
const OPEN_KEY = "bandroom.mixerOpen";
/** The former device-wide choice ("rehearse" meant open); dropped on the first write. */
const LEGACY_KEY = "bandroom.songMode";
/** Keeps the list small; the oldest songs fall back to the Player. */
export const MIXER_OPEN_CAP = 200;

function loadOpenIds(): string[] {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function loadMixerOpen(songId: string): boolean {
  return songId !== "" && loadOpenIds().includes(songId);
}

export function saveMixerOpen(songId: string, open: boolean): void {
  if (songId === "") return;
  const rest = loadOpenIds().filter((id) => id !== songId);
  const ids = open ? [songId, ...rest].slice(0, MIXER_OPEN_CAP) : rest;
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(ids));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // per-device convenience only
  }
}

export interface MixerToggle {
  open: boolean;
  toggle: () => void;
}

/**
 * The song header's Mixer button (SPEC §11.3, §27.4): shows or hides the mixer tools and the
 * track lanes with their headers; the engine plays on either way. `remember` stores the choice per
 * song on this device (members), default closed; link visitors start with the Mixer closed every
 * time and keep one choice across the link's songs (no `songId`). The song page stays mounted
 * across song navigation, so the state follows `songId` during render (no frame showing the
 * previous song's choice).
 */
export function useMixerToggle(remember: boolean, songId = ""): MixerToggle {
  const [state, setState] = useState(() => ({
    songId,
    open: remember && loadMixerOpen(songId),
  }));
  let { open } = state;
  if (state.songId !== songId) {
    open = remember && loadMixerOpen(songId);
    setState({ songId, open });
  }
  return {
    open,
    toggle: () => {
      if (remember) saveMixerOpen(songId, !open);
      setState({ songId, open: !open });
    },
  };
}
