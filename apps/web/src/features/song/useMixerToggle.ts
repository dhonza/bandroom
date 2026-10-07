import { useState } from "react";

/**
 * Remembered per device under the key the former Listen/Rehearse toggle used, so each device
 * keeps its choice ("rehearse" means open).
 */
const MODE_KEY = "bandroom.songMode";

export function loadMixerOpen(): boolean {
  try {
    return localStorage.getItem(MODE_KEY) === "rehearse";
  } catch {
    return false;
  }
}

export function saveMixerOpen(open: boolean): void {
  try {
    localStorage.setItem(MODE_KEY, open ? "rehearse" : "listen");
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
 * track lanes with their headers; the engine plays on either way. `remember` stores the choice on
 * this device (members); link visitors start with the Mixer closed every time.
 */
export function useMixerToggle(remember: boolean): MixerToggle {
  const [open, setOpen] = useState(() => remember && loadMixerOpen());
  return {
    open,
    toggle: () => {
      if (remember) saveMixerOpen(!open);
      setOpen(!open);
    },
  };
}
