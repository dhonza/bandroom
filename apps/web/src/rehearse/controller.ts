import {
  clickTrackFor,
  countInSpecAt,
  Engine,
  SAMPLE_RATE,
  setPlaybackAudioSession,
  WakeLockController,
  type CountInSpec,
  type EngineEvents,
  type EngineState,
} from "@bandroom/audio-engine";
import workerUrl from "@bandroom/audio-engine/worker?worker&url";
import workletUrl from "@bandroom/audio-engine/worklet?worker&url";
import {
  putSongMixer,
  type ClickSettings,
  type MixerState,
  type MixerTrackState,
  type TempoGrid,
  type Track,
  type TrackVersion,
} from "@bandroom/shared";
import { create } from "zustand";
import { api } from "../api/client";
import { blobUrl } from "../lib/media";
import {
  enqueueMixerState,
  offlineQuality,
  playableOffline,
  shouldQueueOffline,
} from "../offline/controller";
import { isLinkMode, saveLocalMix } from "../links/linkMode";
import { claimAudio, registerAudioOwner } from "../player/exclusive";
import { useTempoUi } from "../tempo/store";
import { debugSnapshot, exposeDebug } from "./debug";
import {
  abPartner,
  buildTimeline,
  changedTrims,
  chooseVariant,
  clickSettingsOf,
  clipFor,
  loadKeyOf,
  loudnessOffsetDb,
  mergeMix,
  mergeSnapshot,
  playableTracks,
  recoveredErrors,
  resolveQuality,
  resetMix as resetMixState,
  toggleMyInstrument,
  myInstrumentTracks,
  type PlayableTrack,
  type Quality,
} from "./model";
import {
  cacheBytes,
  connectionInfo,
  isPhoneDevice,
  loadPrefs,
  savePrefs,
  type RehearsePrefs,
} from "./prefs";

export interface RehearseState {
  songId: string | null;
  status: EngineState;
  mix: MixerState;
  tracks: PlayableTrack[];
  quality: Quality;
  prefs: RehearsePrefs;
  /** Seconds buffered ahead per track (thin progress line on track headers). */
  buffer: Record<string, number>;
  /** Underruns in the last 10 s ("audio struggling"). */
  struggling: boolean;
  errors: Record<string, string>;
  /** A/B pair per track: the two version ids being compared. */
  ab: Record<string, { a: string; b: string }>;
  loudnessMatch: boolean;
  /** Playback was cut by a hidden page; suggest Listen mode (SPEC §6.8). */
  lockHint: boolean;
  /** Song end reached. */
  ended: boolean;
  lengthSec: number;
  /** Track picked with 1–9 (SPEC §11.4): `V` flips its A/B pair. */
  selectedTrackId: string | null;
}

export const useRehearse = create<RehearseState>(() => ({
  songId: null,
  status: "idle",
  mix: { tracks: {} },
  tracks: [],
  quality: "high",
  prefs: loadPrefs(),
  buffer: {},
  struggling: false,
  errors: {},
  ab: {},
  loudnessMatch: true,
  lockHint: false,
  ended: false,
  lengthSec: 0,
  selectedTrackId: null,
}));

let engine: Engine | null = null;
let wake: WakeLockController | null = null;
let loadKey = "";
let pendingPlay = false;
/** The song whose audio the engine holds (set once `openSong` starts loading it). */
let loadedSongId: string | null = null;
/** Where and whether to start once the song is loaded (hand-off from the mix player). */
let pendingStart: { songId: string; frames: number; play: boolean } | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let struggleTimer: ReturnType<typeof setTimeout> | null = null;
let allTracks: Track[] = [];
let userTag = "";
/** Loop in seconds, re-applied after a reload of the song's audio. */
let loopSec: { start: number; end: number } | null = null;
/** The last `openSong` call, repeated by `retryAudio` after the engine failed to start. */
let lastOpen: Parameters<typeof openSong> | null = null;
/**
 * "mixer": the personal mix (saved). "default": the song's default mix while its rendered mix is
 * being prepared (SPEC §25.5): track defaults, current versions, never saved.
 */
export type MixMode = "mixer" | "default";
let mixMode: MixMode = "mixer";

function getEngine(): Engine {
  if (engine) return engine;
  const e = new Engine({ workerUrl, workletUrl, cacheBytes: cacheBytes() });
  e.on("state", onEngineState);
  e.on("buffer", (b) => {
    // A failed track that has audio buffered again has recovered (retry, seek, new version).
    const rest = recoveredErrors(useRehearse.getState().errors, b);
    useRehearse.setState(rest ? { buffer: b, errors: rest } : { buffer: b });
  });
  e.on("underrun", () => {
    useRehearse.setState({ struggling: true });
    if (struggleTimer) clearTimeout(struggleTimer);
    struggleTimer = setTimeout(() => {
      useRehearse.setState({ struggling: false });
    }, 10_000);
  });
  e.on("error", (err) => {
    useRehearse.setState((s) => ({ errors: { ...s.errors, [err.trackId]: err.message } }));
  });
  e.on("ended", () => {
    useRehearse.setState({ ended: true });
  });
  // Listen mode takes the audio: pause and suspend the context (the worklet stops running).
  registerAudioOwner("rehearse", () => {
    e.suspend();
  });
  useTempoUi.subscribe(() => {
    syncClick();
  });
  wake = new WakeLockController(useRehearse.getState().prefs.wakeLock);
  document.addEventListener("visibilitychange", onVisibility);
  engine = e;
  exposeDebug(() => debugSnapshot(engine, useRehearse.getState(), songGrid() !== null));
  return e;
}

function onEngineState(s: EngineState) {
  useRehearse.setState({ status: s, ...(s === "playing" ? { ended: false } : {}) });
  wake?.setPlaying(s === "playing" || s === "buffering");
}

function onVisibility() {
  const s = useRehearse.getState();
  if (
    document.visibilityState === "hidden" &&
    (s.status === "playing" || s.status === "buffering")
  ) {
    useRehearse.setState({ lockHint: true });
  }
}

export function subscribeMeters(cb: (m: EngineEvents["meters"]) => void): () => void {
  return getEngine().on("meters", cb);
}

export function positionSec(): number {
  return engine ? engine.getPositionFrames() / SAMPLE_RATE : 0;
}

export function durationSec(): number {
  return engine ? engine.lengthFrames / SAMPLE_RATE : 0;
}

function currentQuality(songId: string | null, tracks: readonly Track[], mix: MixerState): Quality {
  const audible = tracks.filter((t) => !mix.tracks[t.id]?.mute).length;
  const resolved = resolveQuality(useRehearse.getState().prefs.quality, {
    ...connectionInfo(),
    phone: isPhoneDevice(),
    audibleTracks: audible,
    preferLossless: useRehearse.getState().prefs.preferLossless,
  });
  // Offline: the files this device downloaded (SPEC §13).
  return songId ? offlineQuality(songId, resolved) : resolved;
}

/**
 * Loads (or refreshes) a song in the engine. Called when the Rehearse panel mounts and whenever
 * the song's tracks change; reloads only when the audio itself changed, keeping the position.
 */
export async function openSong(
  songId: string,
  tracks: Track[],
  saved: MixerState | null,
  listenedVersions: Record<string, TrackVersion | undefined>,
  instrumentTag: string,
  mode: MixMode = "mixer",
): Promise<void> {
  lastOpen = [songId, tracks, saved, listenedVersions, instrumentTag, mode];
  allTracks = tracks;
  userTag = instrumentTag;
  const e = getEngine();
  const s = useRehearse.getState();
  const sameSong = s.songId === songId;
  const modeChanged = sameSong && mode !== mixMode;
  // Leaving the personal mix: save it before the default mix replaces the state.
  if (modeChanged && mixMode === "mixer") flushSave();
  mixMode = mode;
  const mix =
    mode === "default"
      ? mergeMix(tracks, null)
      : mergeMix(tracks, sameSong && !modeChanged ? s.mix : saved);
  const quality = currentQuality(songId, tracks, mix);
  // Listened versions follow the local mix (A/B choices not saved yet included): the saved mix
  // and its version data lag behind by the save debounce and a refetch.
  const listened: Record<string, TrackVersion | undefined> = {};
  for (const t of tracks) {
    const id = mix.tracks[t.id]?.listenedVersionId;
    if (!id) continue;
    const v =
      (listenedVersions[t.id]?.id === id ? listenedVersions[t.id] : undefined) ??
      (sameSong
        ? s.tracks.find((p) => p.track.id === t.id && p.version.id === id)?.version
        : undefined);
    // Offline without that version on the device: the current version plays (the mix keeps it).
    const file = v && chooseVariant(v, quality, blobUrl);
    listened[t.id] = file && playableOffline(songId, file.variant.hash) ? v : undefined;
  }
  const playable = playableTracks(tracks, listened, quality, blobUrl);
  const key = loadKeyOf(songId, playable);
  const trims = sameSong ? changedTrims(s.tracks, playable) : [];
  useRehearse.setState({
    songId,
    mix,
    tracks: playable,
    quality,
    ...(sameSong
      ? {}
      : { ab: {}, errors: {}, ended: false, lockHint: false, selectedTrackId: null }),
  });
  wake?.setSongOpen(true);
  if (key === loadKey) {
    // Same audio: a changed version gain applies in place (SPEC §25.6).
    for (const c of trims) e.setTrackState(c.trackId, { trimDb: c.trimDb });
    // Another mix over the same audio (default ↔ personal, or new track defaults): in place.
    if (modeChanged || mode === "default") {
      syncClick();
      for (const [id, t] of Object.entries(mix.tracks)) {
        e.setTrackState(id, { gainDb: t.gainDb, pan: t.pan, mute: t.mute, solo: t.solo });
      }
    }
    return;
  }
  loadKey = key;
  loadedSongId = songId;
  const wasPlaying = sameSong && (e.state === "playing" || e.state === "buffering");
  const kept = sameSong ? e.getPositionFrames() : 0;
  const timeline = buildTimeline(playable, mix);
  useRehearse.setState({ lengthSec: timeline.lengthFrames / SAMPLE_RATE });
  try {
    // Superseded by another song (or a dispose): that load continues from here.
    if (!(await e.loadSong(timeline))) return;
  } catch {
    // The engine did not start (status "error"): the retry loads the song again.
    if (loadKey === key) loadKey = "";
    return;
  }
  const start = pendingStart?.songId === songId ? pendingStart : null;
  pendingStart = null;
  const at = start ? start.frames : kept;
  if (at > 0) e.seek(at);
  applyLoop();
  syncClick();
  if (start ? start.play : wasPlaying || pendingPlay) {
    // A hand-off continues the music: no count-in.
    const countIn = !start && pendingPlay ? countInForPlay() : null;
    pendingPlay = false;
    claimAudio("rehearse");
    e.play({ countIn });
  }
}

/**
 * Hand-off from the mix player (Mixer toggle): start this song at `atSec`, playing or paused.
 * Synchronous on purpose, inside the tap (iOS): when the engine already holds the song it seeks
 * and plays right away; otherwise `openSong` applies it once the song is loaded.
 */
export function setPendingStart(songId: string, atSec: number, play: boolean): void {
  const e = getEngine();
  unlockAudio(e);
  const frames = Math.max(0, Math.round(atSec * SAMPLE_RATE));
  pendingPlay = false;
  const st = e.state;
  if (loadedSongId === songId && e.lengthFrames > 0 && st !== "loading" && st !== "idle") {
    pendingStart = null;
    e.seek(Math.min(frames, e.lengthFrames));
    useRehearse.setState({ ended: false, lockHint: false });
    if (play) {
      claimAudio("rehearse");
      e.play({ countIn: null });
    } else if (st === "playing" || st === "buffering") e.pause();
    return;
  }
  pendingStart = { songId, frames, play };
}

/**
 * Hand-off to the mix player: where this song is and whether it plays (including a start that
 * is still waiting for the song to load), then stops the engine.
 */
export function releasePlayback(songId: string): { atSec: number; playing: boolean } {
  let out = { atSec: 0, playing: false };
  if (pendingStart?.songId === songId) {
    out = { atSec: pendingStart.frames / SAMPLE_RATE, playing: pendingStart.play };
  } else if (useRehearse.getState().songId === songId) {
    out = { atSec: positionSec(), playing: isPlaying() || pendingPlay };
  }
  pendingStart = null;
  pendingPlay = false;
  engine?.pause();
  useRehearse.setState({ lockHint: false });
  return out;
}

/**
 * Creates (or resumes) the AudioContext; call inside a tap so iOS unlocks audio (SPEC §6.8). A
 * failure is shown as status "error" with a retry, so it is only logged here.
 */
function unlockAudio(e: Engine): void {
  e.init().catch((err: unknown) => {
    console.warn("Audio engine failed to start", err);
  });
  setPlaybackAudioSession();
}

/** Creates the AudioContext inside a tap (e.g. switching to Rehearse) so iOS unlocks audio. */
export function prepareEngine(): void {
  unlockAudio(getEngine());
}

/**
 * After a failed start (status "error"): starts the engine again inside this tap, reloads the
 * song and plays it once loaded.
 */
export function retryAudio(): void {
  const e = getEngine();
  unlockAudio(e);
  useRehearse.setState({ lockHint: false });
  claimAudio("rehearse");
  pendingPlay = true;
  loadKey = "";
  if (lastOpen) void openSong(...lastOpen);
}

/** Leaving the song page: stop and save. */
export function closeSong(): void {
  engine?.pause();
  wake?.setSongOpen(false);
  flushSave();
}

/**
 * Play/pause. Synchronous on purpose: the first call must run inside the tap so iOS unlocks the
 * AudioContext (SPEC §6.8).
 */
export function togglePlay(): void {
  const e = getEngine();
  if (e.state === "error") {
    retryAudio();
    return;
  }
  unlockAudio(e);
  const st = e.state;
  if (st === "playing" || st === "buffering") {
    e.pause();
    return;
  }
  claimAudio("rehearse");
  useRehearse.setState({ lockHint: false });
  if (st === "loading" || st === "idle") {
    pendingPlay = true;
    return;
  }
  e.play({ countIn: countInForPlay() });
}

export function pause(): void {
  engine?.pause();
}

export function seekSec(sec: number): void {
  const e = engine;
  if (!e) return;
  e.seek(Math.max(0, Math.min(sec, durationSec())) * SAMPLE_RATE);
  useRehearse.setState({ ended: false });
}

export function skip(deltaSec: number): void {
  seekSec(positionSec() + deltaSec);
}

function applyLoop() {
  engine?.setLoop(
    loopSec ? { start: loopSec.start * SAMPLE_RATE, end: loopSec.end * SAMPLE_RATE } : null,
  );
}

/** Frame-accurate loop (SPEC §7.6), applied while playing without a rebuffer. */
export function setLoopSec(range: { start: number; end: number } | null): void {
  loopSec = range;
  applyLoop();
  syncRepeatCountIn();
}

// ——— click and count-in (SPEC §6.7) ——————————————————————————————————————————————

/** The open song's tempo grid (none: click and count-in are off). */
function songGrid(): TempoGrid | null {
  const t = useTempoUi.getState();
  const songId = useRehearse.getState().songId;
  return songId !== null && t.songId === songId ? t.grid : null;
}

export function hasTempo(): boolean {
  return songGrid() !== null;
}

let clickKey: { grid: TempoGrid | null; length: number; sub: number; eighths: boolean } | null =
  null;

/** Pushes the click settings, the click track and the repeat count-in to the engine. */
function syncClick() {
  const e = engine;
  if (!e || e.lengthFrames <= 0) return;
  const c = clickSettingsOf(useRehearse.getState().mix);
  const grid = songGrid();
  e.setClick({
    enabled: c.enabled && grid !== null,
    gainDb: c.gainDb,
    accent: c.accent,
    sound: c.sound,
    solo: c.solo && grid !== null,
    soloExcludes: c.soloExcludes,
  });
  const k = clickKey;
  if (
    !k ||
    k.grid !== grid ||
    k.length !== e.lengthFrames ||
    k.sub !== c.subdivision ||
    k.eighths !== c.compoundEighths
  ) {
    clickKey = {
      grid,
      length: e.lengthFrames,
      sub: c.subdivision,
      eighths: c.compoundEighths,
    };
    e.setClickTrack(
      grid
        ? clickTrackFor(grid, e.lengthFrames, {
            subdivision: c.subdivision,
            compoundEighths: c.compoundEighths,
          })
        : null,
    );
  }
  syncRepeatCountIn();
}

/** "Count-in every repeat": with the tempo and meter at the loop start (SPEC §6.7). */
function syncRepeatCountIn() {
  const e = engine;
  if (!e) return;
  const c = clickSettingsOf(useRehearse.getState().mix);
  const grid = songGrid();
  e.setRepeatCountIn(
    grid && loopSec && c.countIn && c.countInEveryRepeat
      ? countInSpecAt(grid, loopSec.start * SAMPLE_RATE, c.countInBars, c.compoundEighths)
      : null,
  );
}

/** The count-in before playback starts at the playhead, when it is on. */
function countInForPlay(): CountInSpec | null {
  const e = engine;
  const grid = songGrid();
  const c = clickSettingsOf(useRehearse.getState().mix);
  if (!e || !grid || !c.countIn) return null;
  return countInSpecAt(grid, e.getPositionFrames(), c.countInBars, c.compoundEighths);
}

export function setClickSettings(patch: Partial<ClickSettings>): void {
  const { mix } = useRehearse.getState();
  useRehearse.setState({ mix: { ...mix, click: { ...clickSettingsOf(mix), ...patch } } });
  syncClick();
  scheduleSave();
}

/** `C`: click on/off; false without a tempo map. */
export function toggleClick(): boolean {
  if (!hasTempo()) return false;
  setClickSettings({ enabled: !clickSettingsOf(useRehearse.getState().mix).enabled });
  return true;
}

/** `K`: count-in on/off; false without a tempo map. */
export function toggleCountIn(): boolean {
  if (!hasTempo()) return false;
  setClickSettings({ countIn: !clickSettingsOf(useRehearse.getState().mix).countIn });
  return true;
}

/** The count-in being played ("2… 3… 4…"), or null. */
export function countInNow(): { beat: number; clicks: number } | null {
  return engine?.getCountIn() ?? null;
}

export function isPlaying(): boolean {
  const st = engine?.state;
  return st === "playing" || st === "buffering";
}

export function selectTrack(index: number): void {
  const p = useRehearse.getState().tracks[index];
  if (p) useRehearse.setState({ selectedTrackId: p.track.id });
}

// ——— mixer ———————————————————————————————————————————————————————————————————————

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 1500);
}

function flushSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  // The default mix is not the user's: nothing to save.
  if (mixMode === "default") return;
  const { songId, mix } = useRehearse.getState();
  if (!songId || Object.keys(mix.tracks).length === 0) return;
  if (isLinkMode()) saveLocalMix(songId, mix);
  else
    void api(putSongMixer, { params: { id: songId }, body: { state: mix } }).catch(
      (err: unknown) => {
        // Offline: keep the latest state in the outbox (SPEC §13).
        if (shouldQueueOffline(err)) void enqueueMixerState(songId, mix);
      },
    );
}

function applyMix(mix: MixerState) {
  useRehearse.setState({ mix });
  syncClick();
  for (const [id, s] of Object.entries(mix.tracks)) {
    engine?.setTrackState(id, { gainDb: s.gainDb, pan: s.pan, mute: s.mute, solo: s.solo });
  }
  scheduleSave();
}

export function setTrack(trackId: string, patch: Partial<MixerTrackState>): void {
  const { mix } = useRehearse.getState();
  const cur = mix.tracks[trackId];
  if (!cur) return;
  const next = { ...cur, ...patch };
  useRehearse.setState({ mix: { ...mix, tracks: { ...mix.tracks, [trackId]: next } } });
  engine?.setTrackState(trackId, {
    gainDb: next.gainDb,
    pan: next.pan,
    mute: next.mute,
    solo: next.solo,
  });
  scheduleSave();
}

export function resetMix(): void {
  applyMix(resetMixState(allTracks, useRehearse.getState().mix));
}

export function hasMyInstrument(): boolean {
  return myInstrumentTracks(allTracks, userTag).length > 0;
}

export function muteMyInstrument(): void {
  applyMix(toggleMyInstrument(useRehearse.getState().mix, myInstrumentTracks(allTracks, userTag)));
}

/** Applies a snapshot's gain/pan/mute/solo (listened versions stay as they are). */
export function applySnapshot(state: MixerState): void {
  applyMix(mergeSnapshot(useRehearse.getState().mix, state));
}

// ——— versions, A/B, quality ——————————————————————————————————————————————————————

function offsetFor(
  trackId: string,
  version: TrackVersion,
  versions: readonly TrackVersion[],
): number {
  const s = useRehearse.getState();
  const pair = s.ab[trackId];
  if (!s.loudnessMatch || !pair) return 0;
  const otherId = abPartner(pair, version.id);
  const other = versions.find((v) => v.id === otherId);
  return loudnessOffsetDb(
    version.media?.integratedLufs ?? null,
    other?.media?.integratedLufs ?? null,
  );
}

/** Plays another version of a track for me (personal; SPEC §11.3), keeping the position. */
export function listenToVersion(
  trackId: string,
  version: TrackVersion,
  versions: readonly TrackVersion[] = [],
): void {
  const s = useRehearse.getState();
  const idx = s.tracks.findIndex((p) => p.track.id === trackId);
  const p = s.tracks[idx];
  if (!p) return;
  const chosen = chooseVariant(version, s.quality, blobUrl);
  if (!chosen || version.status !== "ready") return;
  const isCurrent = p.track.current?.id === version.id;
  const tracks = [...s.tracks];
  tracks[idx] = { ...p, version, chosen };
  const cur = s.mix.tracks[trackId];
  const mix = cur
    ? {
        ...s.mix,
        tracks: {
          ...s.mix.tracks,
          [trackId]: { ...cur, listenedVersionId: isCurrent ? null : version.id },
        },
      }
    : s.mix;
  useRehearse.setState({ tracks, mix });
  // Switched in place: the engine now holds this, so openSong need not reload it.
  if (s.songId) loadKey = loadKeyOf(s.songId, tracks);
  engine?.switchSource(
    trackId,
    [clipFor(version, chosen)],
    offsetFor(trackId, version, versions),
    version.gainDb,
  );
  scheduleSave();
}

/** Starts comparing the playing version with `other` and switches to it (SPEC §6.9). */
export function startAB(
  trackId: string,
  other: TrackVersion,
  versions: readonly TrackVersion[],
): void {
  const p = useRehearse.getState().tracks.find((x) => x.track.id === trackId);
  if (!p || p.version.id === other.id) return;
  useRehearse.setState((s) => ({ ab: { ...s.ab, [trackId]: { a: p.version.id, b: other.id } } }));
  listenToVersion(trackId, other, versions);
}

/** Flips between the two versions of the track's A/B pair. */
export function toggleAB(trackId: string, versions: readonly TrackVersion[]): void {
  const s = useRehearse.getState();
  const pair = s.ab[trackId];
  const p = s.tracks.find((x) => x.track.id === trackId);
  if (!pair || !p) return;
  const nextId = abPartner(pair, p.version.id);
  const next = versions.find((v) => v.id === nextId);
  if (next) listenToVersion(trackId, next, versions);
}

/**
 * A new gain for the version a track plays (SPEC §25.6), applied right away while the change is
 * saved; the next track refresh confirms or reverts it.
 */
export function setVersionGain(trackId: string, versionId: string, gainDb: number): void {
  const s = useRehearse.getState();
  const tracks = s.tracks.map((p) =>
    p.track.id === trackId && p.version.id === versionId
      ? { ...p, version: { ...p.version, gainDb } }
      : p,
  );
  useRehearse.setState({ tracks });
  if (tracks.some((p) => p.track.id === trackId && p.version.id === versionId))
    engine?.setTrackState(trackId, { trimDb: gainDb });
}

export function stopAB(trackId: string): void {
  useRehearse.setState((s) => ({
    ab: Object.fromEntries(Object.entries(s.ab).filter(([id]) => id !== trackId)),
  }));
  engine?.setTrackState(trackId, { offsetDb: 0 });
}

export function setLoudnessMatch(
  on: boolean,
  versionsByTrack: Record<string, readonly TrackVersion[]>,
): void {
  useRehearse.setState({ loudnessMatch: on });
  for (const p of useRehearse.getState().tracks) {
    if (!useRehearse.getState().ab[p.track.id]) continue;
    const offsetDb = offsetFor(p.track.id, p.version, versionsByTrack[p.track.id] ?? []);
    engine?.setTrackState(p.track.id, { offsetDb });
  }
}

export function setPrefs(patch: Partial<RehearsePrefs>): void {
  const prefs = { ...useRehearse.getState().prefs, ...patch };
  savePrefs(prefs);
  useRehearse.setState({ prefs });
  if (patch.wakeLock) wake?.setMode(patch.wakeLock);
  if (patch.quality !== undefined || patch.preferLossless !== undefined) applyQuality();
}

/** Re-resolves the quality and switches every track whose file changes (seamless). */
function applyQuality() {
  const s = useRehearse.getState();
  const quality = currentQuality(
    s.songId,
    s.tracks.map((p) => p.track),
    s.mix,
  );
  if (quality === s.quality) return;
  const tracks = s.tracks.map((p) => {
    const chosen = chooseVariant(p.version, quality, blobUrl) ?? p.chosen;
    if (chosen.variant.hash !== p.chosen.variant.hash) {
      engine?.switchSource(p.track.id, [clipFor(p.version, chosen)]);
    }
    return { ...p, chosen };
  });
  if (s.songId) loadKey = loadKeyOf(s.songId, tracks);
  useRehearse.setState({ quality, tracks });
}

export function dismissLockHint(): void {
  useRehearse.setState({ lockHint: false });
}
