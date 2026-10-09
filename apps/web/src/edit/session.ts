import {
  initialClip,
  uuidv7,
  type EditBase,
  type Track,
  type TrackVersion,
} from "@bandroom/shared";
import { enterEdit, exitEdit, useEdit } from "./store";

/**
 * Edit sessions (SPEC §24.7). Until the server contracts exist the session lives on this page
 * only (no autosave, no lock).
 */

/** Length of a version at 48 kHz (what the clips can reveal). */
export function versionFrames(v: TrackVersion): number {
  const opus = v.variants.opus ?? v.variants.opusLow;
  if (opus) return opus.durationSamples48k;
  const flac = v.variants.flac;
  if (flac && flac.sampleRate > 0)
    return Math.round((flac.durationSamples * 48_000) / flac.sampleRate);
  return Math.round((v.media?.durationSec ?? 0) * 48_000);
}

/** The base of a new session: the current, ready versions of the tracks (SPEC §24.7). */
export function baseOf(
  tracks: readonly Track[],
): { base: EditBase; versions: Record<string, TrackVersion> } | null {
  const versions: Record<string, TrackVersion> = {};
  const out: EditBase["tracks"] = [];
  for (const t of tracks) {
    const v = t.current;
    if (!v || v.status !== "ready") continue;
    const lengthFrames = versionFrames(v);
    if (lengthFrames < 1) continue;
    versions[v.id] = v;
    const bt = {
      trackId: t.id,
      versionId: v.id,
      offsetSamples: v.offsetSamples,
      gainDb: v.gainDb,
      lengthFrames,
    };
    out.push({ ...bt, clip: initialClip(bt) });
  }
  if (out.length === 0) return null;
  return { base: { tracks: out, remap: [], foldedOps: 0 }, versions };
}

export async function startEditSession(songId: string, tracks: readonly Track[]): Promise<boolean> {
  const b = baseOf(tracks);
  if (!b) return false;
  enterEdit({
    session: { id: uuidv7(), songId, rev: 0 },
    base: b.base,
    ops: [],
    cursor: 0,
    options: useEdit.getState().options,
    versions: b.versions,
  });
  return Promise.resolve(true);
}

export async function cancelEditSession(): Promise<void> {
  exitEdit();
  return Promise.resolve();
}
