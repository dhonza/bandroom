import { opusKbps, type AudioQuality } from "@bandroom/shared";
import type { Db } from "../db/connection";
import { getSetting } from "../settings/registry";

/**
 * The `opus` bitrate of a preset (SPEC §28.2); `standard` is the instance's
 * `audio.opusBitrates` setting.
 */
export function opusKbpsFor(db: Db, quality: AudioQuality, mono: boolean): number {
  const b = getSetting(db, "audio.opusBitrates");
  return opusKbps(quality, mono, { stereo: b.trackStereo, mono: b.trackMono });
}
