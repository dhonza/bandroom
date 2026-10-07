/**
 * The song player's Mixer toggle (DECISIONS 2026-09-29): closed plays the stereo mix through
 * `<audio>`, open plays the multitrack engine. Remembered per device under the key the former
 * Listen/Rehearse toggle used, so each device keeps its choice ("rehearse" means open).
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

export interface MixerFacts {
  /** The stored choice of this device. */
  stored: boolean;
  trackCount: number;
  /** The song's mix (mix track or automatic mix) can play through `<audio>`. */
  mixPlayable: boolean;
  /** The mix player is already playing this song (e.g. from the mini-player). */
  listenPlayingThisSong: boolean;
}

/**
 * Whether the mixer starts open when the song page loads. Decided once; after that only the
 * user's toggles change it.
 */
export function initialMixerOpen(f: MixerFacts): boolean {
  if (f.trackCount === 0) return false;
  // Opening the page must not interrupt the mix that is playing.
  if (f.listenPlayingThisSong) return false;
  // Without a mix yet, the closed Mixer plays the tracks with the default mix (SPEC §25.5).
  return f.stored;
}
