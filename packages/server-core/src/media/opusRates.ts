import { opusKbps, type AudioQuality } from "@bandroom/shared";
import type { Db } from "../db/connection";
import { getSetting } from "../settings/registry";

/**
 * The `opus` bitrate of a preset (SPEC §28.2); `standard` is the instance's
 * `audio.opusBitrates` setting.
 */
export function opusKbpsFor(db: Db, quality: AudioQuality, mono: boolean): number {
  return opusKbps(quality, mono, standardOpusKbps(db));
}

/** The `standard` preset's bitrates on this instance (the `audio.opusBitrates` setting). */
export function standardOpusKbps(db: Db): { stereo: number; mono: number } {
  const b = getSetting(db, "audio.opusBitrates");
  return { stereo: b.trackStereo, mono: b.trackMono };
}
