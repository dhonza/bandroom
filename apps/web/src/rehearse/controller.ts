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
  type Song,
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
import { installMediaActions, setMediaInfo, setMediaPlaying } from "../player/mediaSession";
import {
  dropGone,
  focusSong,
  nextReadyIndex,
  startIndex,
  type GoneSongs,
  type PlayQueue,
  type QueueEntry,
  type QueueSource,
  waitingAfter,
  withFreshReady,
} from "../player/queue";
import type { QueueLoader } from "../player/queueLoader";
import { setSongTempo, useTempoUi } from "../tempo/store";
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

/** What the mini-player and the media controls show about the loaded song. */
export interface SongInfo {
  songId: string;
  title: string;
  subtitle: string;
  projectId: string;
  projectName: string;
  imageHash: string | null;
}

export function songInfoOf(song: Song): SongInfo {
  return {
    songId: song.id,
    title: song.title,
    subtitle: song.subtitle,
    projectId: song.project.id,
    projectName: song.project.name,
    imageHash: song.project.imageHash,
  };
}

export interface RehearseState {
  songId: string | null;
  /** The loaded song's title and project (mini-player, Media Session). */
  info: SongInfo | null;
  /**
   * A song session is open: on its page, or playing on (or paused) elsewhere with the
   * mini-player (SPEC §6.10). Closed when the user leaves a stopped song or stops the player.
   */
  open: boolean;
  /** The play queue (SPEC §6.10); a song opened on its page is a queue of its own. */
  queue: PlayQueue | null;
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
  /** Playback was cut by a hidden page or a locked screen (SPEC §6.8). */
  lockHint: boolean;
  /** Song end reached. */
  ended: boolean;
  lengthSec: number;
  /** Track picked with 1–9 (SPEC §11.4): `V` flips its A/B pair. */
  selectedTrackId: string | null;
}

export const useRehearse = create<RehearseState>(() => ({
  songId: null,
  info: null,
  open: false,
  queue: null,
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
/** Play once the loading song is in: after a tap (with the count-in) or the queue (without). */
let pendingPlay: "countIn" | "plain" | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let struggleTimer: ReturnType<typeof setTimeout> | null = null;
let allTracks: Track[] = [];
let userTag = "";
/** Loop in seconds, re-applied after a reload of the song's audio. */
let loopSec: { start: number; end: number } | null = null;
/** The last `openSong` call, repeated by `retryAudio` after the engine failed to start. */
let lastOpen: Parameters<typeof openSong> | null = null;
/** The song whose page shows the Player (SPEC §6.10: leaving it keeps a playing song). */
let attachedSongId: string | null = null;
let queueLoader: QueueLoader | null = null;
/** Bumped by every queue load: a superseded load does not touch the engine. */
let queueLoad = 0;

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
  e.on("ended", onEnded);
  installMediaActions({
    play: () => {
      if (!isPlaying()) togglePlay();
    },
    pause,
    previous: previousSong,
    next: nextSong,
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
  const playing = s === "playing" || s === "buffering";
  wake?.setPlaying(playing);
  if (useRehearse.getState().open) setMediaPlaying(playing);
}

/** The song ended: the queue's next ready song plays; at the queue's end a song left alone closes. */
function onEnded() {
  useRehearse.setState({ ended: true });
  const s = useRehearse.getState();
  const next = s.queue ? nextReadyIndex(s.queue.entries, s.queue.index, 1) : null;
  if (next !== null) {
    playQueueIndex(next);
    return;
  }
  const q = s.queue;
  const loader = queueLoader;
  if (q?.source.kind === "project" && loader && waitingAfter(q)) {
    // Songs that were still processing when the queue started may be ready now.
    const token = ++queueLoad;
    loader
      .entries(q.source.projectId)
      .then((fresh) => {
        const cur = useRehearse.getState().queue;
        if (token !== queueLoad || !cur) return;
        const entries = withFreshReady(cur.entries, fresh);
        useRehearse.setState({ queue: { ...cur, entries } });
        const i = nextReadyIndex(entries, cur.index, 1);
        if (i !== null) playQueueIndex(i);
        else endOfQueue();
      })
      .catch(() => {
        if (token === queueLoad) endOfQueue();
      });
    return;
  }
  endOfQueue();
}

/** Nothing more to play: a song left alone (the user is elsewhere) closes. */
function endOfQueue() {
  if (useRehearse.getState().songId !== attachedSongId) closeSong();
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
  info: SongInfo,
): Promise<void> {
  lastOpen = [songId, tracks, saved, listenedVersions, instrumentTag, info];
  allTracks = tracks;
  userTag = instrumentTag;
  const e = getEngine();
  const s = useRehearse.getState();
  const sameSong = s.songId === songId;
  if (!sameSong) {
    // The previous song's mix is saved under its own id; its loop does not carry over.
    flushSave();
    loopSec = null;
  }
  const mix = mergeMix(tracks, sameSong ? s.mix : saved);
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
  const entry: QueueEntry = { songId, title: info.title, subtitle: info.subtitle, ready: true };
  useRehearse.setState({
    songId,
    info,
    open: true,
    queue: focusSong(s.queue, entry, queueSourceOf(info)),
    mix,
    tracks: playable,
    quality,
    ...(sameSong
      ? {}
      : { ab: {}, errors: {}, ended: false, lockHint: false, selectedTrackId: null }),
  });
  wake?.setSongOpen(true);
  setMediaInfo(info);
  if (key === loadKey) {
    // Same audio: a changed version gain applies in place (SPEC §25.6).
    for (const c of trims) e.setTrackState(c.trackId, { trimDb: c.trimDb });
    return;
  }
  loadKey = key;
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
  if (kept > 0) e.seek(kept);
  applyLoop();
  syncClick();
  if (wasPlaying || pendingPlay) {
    // A reload continues the music: no count-in; neither does the queue moving on.
    const countIn = pendingPlay === "countIn" ? countInForPlay() : null;
    pendingPlay = null;
    e.play({ countIn });
  }
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
  pendingPlay = "countIn";
  loadKey = "";
  if (lastOpen) void openSong(...lastOpen);
}

function queueSourceOf(info: SongInfo): QueueSource {
  return {
    kind: "song",
    projectId: info.projectId,
    projectName: info.projectName,
    imageHash: info.imageHash,
  };
}

/**
 * Stops and saves; the mini-player goes and the queue ends. The engine keeps the song's audio,
 * so opening its page again continues where it stood.
 */
export function closeSong(): void {
  queueLoad++;
  pendingPlay = null;
  engine?.pause();
  wake?.setSongOpen(false);
  flushSave();
  if (useRehearse.getState().open) {
    useRehearse.setState({ open: false, queue: null });
    setMediaInfo(null);
    setMediaPlaying(null);
  }
}

/**
 * The song page shows the Player for `songId`. Leaving the page keeps a playing song (the
 * mini-player takes over, SPEC §6.10); a stopped one closes.
 */
export function attachPage(songId: string): () => void {
  attachedSongId = songId;
  return () => {
    if (attachedSongId === songId) attachedSongId = null;
    const s = useRehearse.getState();
    if (s.songId === songId && !isPlaying() && pendingPlay === null) closeSong();
  };
}

// ——— queue (SPEC §6.10) ———————————————————————————————————————————————————————————

/**
 * Starts a queue (a project's "Play all", a song row's play button) at `songId` or its first
 * song; skips songs without audio. False when nothing can play. Call inside the tap: it unlocks
 * the audio (iOS) before the song loads.
 */
export function startQueue(
  entries: QueueEntry[],
  source: QueueSource,
  loader: QueueLoader,
  songId?: string,
): boolean {
  const first = startIndex(entries, songId);
  if (first === null) return false;
  unlockAudio(getEngine());
  queueLoader = loader;
  useRehearse.setState({ queue: { entries, index: first, source }, lockHint: false });
  playQueueIndex(first);
  return true;
}

/** Loads the queue's entry at `index` with the personal mix and plays it from the start. */
function playQueueIndex(index: number): void {
  const s = useRehearse.getState();
  const q = s.queue;
  const entry = q?.entries[index];
  if (!q || !entry) return;
  const token = ++queueLoad;
  useRehearse.setState({ queue: { ...q, index }, ended: false });
  if (s.songId === entry.songId && s.open && loadKey !== "") {
    // Already in the engine: from the start.
    seekSec(0);
    engine?.play();
    return;
  }
  const loader = queueLoader;
  if (!loader) return;
  engine?.pause();
  pendingPlay = "plain";
  loader
    .load(entry.songId)
    .then(async (d) => {
      if (token !== queueLoad) return;
      setSongTempo(d.song.id, d.tempo);
      await openSong(d.song.id, d.tracks, d.saved, d.listened, userTag, songInfoOf(d.song));
    })
    .catch(() => {
      if (token !== queueLoad) return;
      // Not loadable (gone, offline without it): on to the next song, or stop.
      const cur = useRehearse.getState().queue;
      const next = cur ? nextReadyIndex(cur.entries, index, 1) : null;
      if (next !== null) playQueueIndex(next);
      else {
        pendingPlay = null;
        endOfQueue();
      }
    });
}

/** Next song of the queue (mini-player, media controls). */
export function nextSong(): void {
  const q = useRehearse.getState().queue;
  const next = q ? nextReadyIndex(q.entries, q.index, 1) : null;
  if (next !== null) playQueueIndex(next);
}

/** Media-control convention: restart the song when more than 3 s in, else the previous song. */
export function previousSong(): void {
  const q = useRehearse.getState().queue;
  const prev = q ? nextReadyIndex(q.entries, q.index, -1) : null;
  if (positionSec() > 3 || prev === null) seekSec(0);
  else playQueueIndex(prev);
}

export function hasNextSong(s: RehearseState = useRehearse.getState()): boolean {
  return s.queue !== null && nextReadyIndex(s.queue.entries, s.queue.index, 1) !== null;
}

export function hasPreviousSong(s: RehearseState = useRehearse.getState()): boolean {
  return s.queue !== null && nextReadyIndex(s.queue.entries, s.queue.index, -1) !== null;
}

/**
 * Deleted songs leave the queue (SPEC §6.10). `"stopped"`: the loaded song is among them and
 * playback stopped (the caller says why).
 */
export function dropSongs(gone: GoneSongs): "stopped" | "removed" | "none" {
  const s = useRehearse.getState();
  const loadedGone =
    s.open &&
    s.info !== null &&
    ((gone.songIds ?? []).includes(s.info.songId) || gone.projectId === s.info.projectId);
  const { result, queue } = dropGone(s.queue, gone);
  if (loadedGone || result === "stopped") {
    closeSong();
    return "stopped";
  }
  if (result === "removed") useRehearse.setState({ queue });
  return result;
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
  useRehearse.setState({ lockHint: false });
  if (st === "loading" || st === "idle") {
    pendingPlay = "countIn";
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
