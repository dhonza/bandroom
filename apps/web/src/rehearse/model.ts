import type { EngineClip, EngineVariant, SongTimeline } from "@bandroom/audio-engine";
import {
  type MixerState,
  type MixerTrackState,
  type Track,
  type TrackVersion,
} from "@bandroom/shared";

/** Per-device quality preference (SPEC §6.9). */
export type QualityPref = "auto" | "lossless" | "high" | "low";
export type Quality = "lossless" | "high" | "low";

export interface QualityEnv {
  phone: boolean;
  saveData: boolean;
  /** `navigator.connection.effectiveType` is 2G or slower. */
  slow: boolean;
  /** Estimated downlink in Mbit/s, when the browser tells. */
  downlinkMbps: number | null;
  audibleTracks: number;
  /** "Prefer lossless on this device". */
  preferLossless: boolean;
}

/**
 * `auto`: low when saving data, on a slow link or below 300 kbit/s per audible track; lossless
 * only on desktop with "prefer lossless"; high otherwise (SPEC §6.9).
 */
export function resolveQuality(pref: QualityPref, env: QualityEnv): Quality {
  if (pref !== "auto") return pref;
  if (env.saveData || env.slow) return "low";
  if (env.downlinkMbps !== null && env.audibleTracks > 0) {
    if ((env.downlinkMbps * 1000) / env.audibleTracks < 300) return "low";
  }
  if (!env.phone && env.preferLossless) return "lossless";
  return "high";
}

export interface ChosenVariant {
  variant: EngineVariant;
  /** What actually plays (lossless falls back to Opus when a version has no FLAC). */
  quality: Quality;
}

export function chooseVariant(
  v: TrackVersion,
  quality: Quality,
  blobUrl: (hash: string) => string,
): ChosenVariant | null {
  const { opus, opusLow, flac } = v.variants;
  const idx = v.variants.seekIndex;
  const opusVariant = (ref: NonNullable<typeof opus>, index: string | null): EngineVariant => ({
    kind: "opus",
    hash: ref.hash,
    url: blobUrl(ref.hash),
    seekIndexUrl: index ? blobUrl(index) : null,
    channels: ref.channels,
    dualMono: v.media?.dualMono ?? false,
    preSkip: ref.preSkip,
    totalFrames: ref.durationSamples48k,
    sampleRate: 48_000,
  });
  if (quality === "lossless" && flac && flac.durationSamples > 0) {
    return {
      quality,
      variant: {
        kind: "flac",
        hash: flac.hash,
        url: blobUrl(flac.hash),
        seekIndexUrl: idx.flac ? blobUrl(idx.flac) : null,
        channels: flac.channels,
        dualMono: v.media?.dualMono ?? false,
        preSkip: 0,
        totalFrames: flac.durationSamples,
        sampleRate: flac.sampleRate,
      },
    };
  }
  if (quality === "low" && opusLow)
    return { quality: "low", variant: opusVariant(opusLow, idx.opusLow) };
  if (opus) return { quality: "high", variant: opusVariant(opus, idx.opus) };
  if (opusLow) return { quality: "low", variant: opusVariant(opusLow, idx.opusLow) };
  return null;
}

/** Timeline length of a variant at 48 kHz. */
export function variantFrames(v: EngineVariant): number {
  return v.kind === "opus" ? v.totalFrames : Math.round((v.totalFrames * 48_000) / v.sampleRate);
}

export function clipFor(version: TrackVersion, chosen: ChosenVariant): EngineClip {
  return {
    startFrame: version.offsetSamples,
    sourceOffsetFrame: 0,
    lengthFrames: variantFrames(chosen.variant),
    variant: chosen.variant,
  };
}

/** A track as Rehearse mode plays it: its listened version and the chosen file. */
export interface PlayableTrack {
  track: Track;
  version: TrackVersion;
  chosen: ChosenVariant;
}

export function playableTracks(
  tracks: readonly Track[],
  listened: Readonly<Record<string, TrackVersion | undefined>>,
  quality: Quality,
  blobUrl: (hash: string) => string,
): PlayableTrack[] {
  const out: PlayableTrack[] = [];
  for (const track of tracks) {
    const version = listened[track.id] ?? track.current;
    if (!version || version.status !== "ready") continue;
    const chosen = chooseVariant(version, quality, blobUrl);
    if (chosen) out.push({ track, version, chosen });
  }
  return out;
}

export function buildTimeline(tracks: readonly PlayableTrack[], mix: MixerState): SongTimeline {
  const engineTracks = tracks.map((p) => {
    const s = mix.tracks[p.track.id] ?? defaultTrackState(p.track);
    return {
      id: p.track.id,
      clips: [clipFor(p.version, p.chosen)],
      gainDb: s.gainDb,
      pan: s.pan,
      mute: s.mute,
      solo: s.solo,
      trimDb: p.version.gainDb,
    };
  });
  const lengthFrames = Math.max(
    0,
    ...engineTracks.flatMap((t) => t.clips.map((c) => c.startFrame + c.lengthFrames)),
  );
  return { tracks: engineTracks, lengthFrames };
}

/** Track defaults (SPEC §11.3). */
export function defaultTrackState(track: Track): MixerTrackState {
  return {
    gainDb: track.defaultGainDb,
    pan: track.defaultPan,
    mute: track.defaultMuted,
    solo: false,
    listenedVersionId: null,
  };
}

export function defaultMix(tracks: readonly Track[]): MixerState {
  return {
    tracks: Object.fromEntries(tracks.map((t) => [t.id, defaultTrackState(t)])),
  };
}

/** Saved state for known tracks, defaults for new ones; deleted tracks are dropped. */
export function mergeMix(tracks: readonly Track[], saved: MixerState | null): MixerState {
  const base = defaultMix(tracks);
  if (!saved) return base;
  for (const t of tracks) {
    const s = saved.tracks[t.id];
    if (s) base.tracks[t.id] = { ...s };
  }
  if (saved.click) base.click = { ...saved.click };
  if (saved.practice) base.practice = { ...saved.practice };
  return base;
}

/** The personal click and count-in settings (SPEC §6.7), with defaults for missing keys. */
export { clickSettingsOf } from "@bandroom/shared";

/** Keeps the listened versions, resets gain/pan/mute/solo to the track defaults. */
export function resetMix(tracks: readonly Track[], mix: MixerState): MixerState {
  const base = defaultMix(tracks);
  for (const t of tracks) {
    const cur = mix.tracks[t.id];
    const b = base.tracks[t.id];
    if (cur && b) b.listenedVersionId = cur.listenedVersionId ?? null;
  }
  if (mix.click) base.click = mix.click; // the click is not part of "Reset mix"
  if (mix.practice) base.practice = mix.practice; // nor the practice setting (SPEC §30.2)
  return base;
}

const normTag = (s: string) => s.trim().toLocaleLowerCase();

/** Tracks whose instrument tag matches the user's (SPEC §11.3 "Mute my instrument"). */
export function myInstrumentTracks(tracks: readonly Track[], tag: string): string[] {
  const t = normTag(tag);
  if (!t) return [];
  return tracks.filter((tr) => normTag(tr.instrumentTag) === t).map((tr) => tr.id);
}

/** Mutes the user's tracks, or unmutes them when all are muted already. */
export function toggleMyInstrument(mix: MixerState, ids: readonly string[]): MixerState {
  if (ids.length === 0) return mix;
  const allMuted = ids.every((id) => mix.tracks[id]?.mute);
  const tracks = { ...mix.tracks };
  for (const id of ids) {
    const s = tracks[id];
    if (s) tracks[id] = { ...s, mute: !allMuted };
  }
  return { ...mix, tracks };
}

/**
 * Loudness match for A/B (SPEC §6.9): the louder version is turned down to the quieter one's
 * integrated loudness; nothing is boosted.
 */
export function loudnessOffsetDb(playing: number | null, other: number | null): number {
  if (playing === null || other === null) return 0;
  return Math.min(0, other - playing);
}

/**
 * Version gains that changed between two sets of playing tracks (SPEC §25.6): applied in place,
 * without reloading the song.
 */
export function changedTrims(
  before: readonly PlayableTrack[],
  after: readonly PlayableTrack[],
): { trackId: string; trimDb: number }[] {
  const old = new Map(before.map((p) => [p.track.id, p.version.gainDb]));
  return after
    .filter((p) => old.get(p.track.id) !== p.version.gainDb)
    .map((p) => ({ trackId: p.track.id, trimDb: p.version.gainDb }));
}

/**
 * What the engine holds: the song and each track's version, file and offset. Independent of the
 * track order: the engine addresses tracks by id, so a reorder only moves the lanes (SPEC §28.5).
 */
export function loadKeyOf(songId: string, playable: readonly PlayableTrack[]): string {
  return JSON.stringify([
    songId,
    playable
      .map((p) => [p.track.id, p.version.id, p.chosen.variant.hash, p.version.offsetSamples])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}

/** A snapshot's gain/pan/mute/solo applied to the mix (listened versions stay as they are). */
export function mergeSnapshot(mix: MixerState, state: MixerState): MixerState {
  const tracks = { ...mix.tracks };
  for (const [id, s] of Object.entries(state.tracks)) {
    const cur = tracks[id];
    if (cur) tracks[id] = { ...s, listenedVersionId: cur.listenedVersionId ?? null };
  }
  return { ...mix, tracks };
}

/**
 * Track errors left once failed tracks have audio buffered again (retry, seek, new version), or
 * null when none recovered.
 */
export function recoveredErrors(
  errors: Record<string, string>,
  buffer: Record<string, number>,
): Record<string, string> | null {
  const recovered = Object.keys(errors).filter((id) => (buffer[id] ?? 0) > 0);
  if (recovered.length === 0) return null;
  return Object.fromEntries(Object.entries(errors).filter(([id]) => !recovered.includes(id)));
}

/** The other version of an A/B pair. */
export function abPartner(pair: { a: string; b: string }, versionId: string): string {
  return pair.a === versionId ? pair.b : pair.a;
}
