import { dbToGain, panGainsInto } from "@bandroom/shared/audio";
import type { Track } from "./track";
import { RAMP_FRAMES } from "./types";

/**
 * Recomputes every track's gain targets from mute/solo/gain/pan (SPEC §6.6) and the playing
 * version's gain (`trimDb`, SPEC §25.6) with the A/B loudness offset: immediately, or as
 * a `RAMP_FRAMES` ramp from the current gain. A soloed click (`clickSolo`) silences unsoloed
 * tracks too. `pan` is scratch for the pan law. Returns whether any track is soloed.
 */
export function updateTargets(
  tracks: Track[],
  clickSolo: boolean,
  pan: { left: number; right: number },
  immediate: boolean,
): boolean {
  let solo = false;
  for (let i = 0; i < tracks.length; i++) if (tracks[i]?.params.solo) solo = true;
  const anySolo = solo || clickSolo;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t) continue;
    const p = t.params;
    const on = !p.mute && (!anySolo || p.solo);
    const g = on ? dbToGain(p.gainDb) * dbToGain(p.offsetDb) * dbToGain(p.trimDb) : 0;
    panGainsInto(p.pan, t.mono ? "mono" : "stereo", pan);
    const t0 = g * pan.left;
    const t1 = g * pan.right;
    if (immediate) {
      t.cur0 = t.target0 = t0;
      t.cur1 = t.target1 = t1;
      t.rampLeft = 0;
    } else if (t0 !== t.target0 || t1 !== t.target1) {
      t.target0 = t0;
      t.target1 = t1;
      t.step0 = (t0 - t.cur0) / RAMP_FRAMES;
      t.step1 = (t1 - t.cur1) / RAMP_FRAMES;
      t.rampLeft = RAMP_FRAMES;
    }
  }
  return solo;
}
