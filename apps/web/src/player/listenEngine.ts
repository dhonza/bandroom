import { blobUrl } from "../lib/media";
import { offlineQuality } from "../offline/controller";
import { claimAudio, registerAudioOwner } from "./exclusive";
import {
  currentEntry,
  isPlayable,
  nextPlayableIndex,
  saveQuality,
  useListen,
  type ListenQuality,
  type QueueEntry,
  type RepeatMode,
} from "./listenStore";

/**
 * Listen mode (SPEC §6.10): one `<audio>` element for the whole app, outside React so playback
 * survives navigation. Actions call `play()` synchronously so they work inside a tap handler
 * (iOS audio unlock). Media Session gives lock-screen controls; previous/next are songs.
 */
let audio: HTMLAudioElement | null = null;
let lastPositionState = 0;
/** A position asked for before the source's metadata loaded (applied on `loadedmetadata`). */
let pendingTime: number | null = null;

function el(): HTMLAudioElement {
  if (audio) return audio;
  const a = new Audio();
  a.preload = "auto";
  a.addEventListener("timeupdate", () => {
    useListen.setState({ position: a.currentTime });
    updatePositionState(false);
    checkLoopBoundary();
  });
  a.addEventListener("loadedmetadata", () => {
    if (pendingTime !== null) {
      a.currentTime = pendingTime;
      pendingTime = null;
    }
    useListen.setState({ duration: Number.isFinite(a.duration) ? a.duration : 0 });
    updatePositionState(true);
  });
  a.addEventListener("play", () => {
    claimAudio("listen");
    startLoopWatch();
  });
  a.addEventListener("playing", () => {
    useListen.setState({ status: "playing" });
    setPlaybackState("playing");
  });
  a.addEventListener("pause", () => {
    if (useListen.getState().status !== "loading") useListen.setState({ status: "paused" });
    setPlaybackState("paused");
  });
  a.addEventListener("waiting", () => {
    useListen.setState({ status: "loading" });
  });
  a.addEventListener("ended", onEnded);
  a.addEventListener("error", () => {
    useListen.setState({ status: "error" });
  });
  audio = a;
  registerAudioOwner("listen", () => {
    a.pause();
  });
  installMediaSession();
  return a;
}

function sourceUrl(e: QueueEntry, preferred: ListenQuality): string | null {
  const l = e.listen;
  if (!l) return null;
  // Offline: the file this device downloaded (SPEC §6.10, §13).
  const quality = offlineQuality(e.songId, preferred);
  const pick = quality === "low" ? (l.opusLow ?? l.opus) : (l.opus ?? l.opusLow);
  return pick ? blobUrl(pick.hash) : null;
}

function load(index: number, startAt = 0, autoplay = true): void {
  const s = useListen.getState();
  const entry = s.queue[index];
  if (!entry) return;
  const url = sourceUrl(entry, s.quality);
  if (!url) return;
  const a = el();
  useListen.setState({
    index,
    status: autoplay ? "loading" : "paused",
    position: startAt,
    duration: entry.listen?.durationSec ?? 0,
  });
  if (a.src !== new URL(url, document.baseURI).href) a.src = url;
  pendingTime = null;
  if (startAt > 0) setTime(a, startAt);
  updateMetadata(entry);
  if (autoplay)
    void a.play().catch(() => {
      useListen.setState({ status: "paused" });
    });
}

/** Seeks now, or once the metadata is there (Safari ignores a seek before it). */
function setTime(a: HTMLAudioElement, t: number): void {
  if (a.readyState >= HTMLMediaElement.HAVE_METADATA) a.currentTime = t;
  else pendingTime = t;
}

function onEnded(): void {
  const s = useListen.getState();
  if (loopRange && loopActive() && audio) {
    // A loop reaching the song end starts over instead of moving to the next song.
    audio.currentTime = loopRange.start;
    void audio.play().catch(() => undefined);
    return;
  }
  if (s.repeat === "one") {
    load(s.index, 0);
    return;
  }
  const next = nextPlayableIndex(s.queue, s.index, 1, s.repeat === "all");
  if (next === null) useListen.setState({ status: "paused", position: 0 });
  else load(next, 0);
}

// --- Public actions -------------------------------------------------------------------------

/** Starts a queue at `startIndex` (e.g. "Play all" on a project). Must be called from a gesture. */
export function playQueue(
  queue: QueueEntry[],
  startIndex = 0,
  opts: { startAt?: number; autoplay?: boolean } = {},
): void {
  useListen.setState({ queue });
  const start = queue[startIndex];
  const first =
    start && isPlayable(start) ? startIndex : nextPlayableIndex(queue, startIndex, 1, false);
  // `autoplay: false` cues the song (e.g. a timeline tap on a song that is not playing).
  if (first !== null) {
    load(first, first === startIndex ? (opts.startAt ?? 0) : 0, opts.autoplay ?? true);
  }
}

export function togglePlay(): void {
  const a = el();
  const s = useListen.getState();
  if (!currentEntry(s)) return;
  if (a.paused)
    void a.play().catch(() => {
      useListen.setState({ status: "paused" });
    });
  else a.pause();
}

export function pause(): void {
  audio?.pause();
}

export function seek(sec: number): void {
  const a = el();
  const d = useListen.getState().duration || a.duration || 0;
  const t = Math.max(0, d ? Math.min(sec, d) : sec);
  setTime(a, t);
  useListen.setState({ position: t });
  updatePositionState(true);
}

export function next(): void {
  const s = useListen.getState();
  const i = nextPlayableIndex(s.queue, s.index, 1, s.repeat === "all");
  if (i !== null) load(i, 0);
}

/** Lock-screen convention: restart the song if more than 3 s in, else go to the previous song. */
export function previous(): void {
  const s = useListen.getState();
  if (currentTime() > 3) {
    seek(0);
    return;
  }
  const i = nextPlayableIndex(s.queue, s.index, -1, s.repeat === "all");
  if (i !== null) load(i, 0);
  else seek(0);
}

export function setRepeat(repeat: RepeatMode): void {
  useListen.setState({ repeat });
}

/** Switches quality keeping the position (SPEC §6.9 quality applies to Listen mode too). */
export function setQuality(quality: ListenQuality): void {
  saveQuality(quality);
  const s = useListen.getState();
  useListen.setState({ quality });
  if (currentEntry(s) && audio) {
    const wasPlaying = !audio.paused;
    load(s.index, audio.currentTime, wasPlaying);
  }
}

export function stop(): void {
  pendingTime = null;
  audio?.pause();
  if (audio) audio.removeAttribute("src");
  useListen.setState({ queue: [], index: 0, status: "idle", position: 0, duration: 0 });
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
}

/** Songs that were deleted: by id, or every song of a deleted project. */
export interface GoneSongs {
  songIds?: readonly string[];
  projectId?: string;
}

/**
 * Takes deleted songs out of the queue (the queue is a snapshot, SPEC §6.10). When the playing
 * song is among them, playback stops (`"stopped"`, the caller says why); otherwise the entries go
 * and the current song keeps playing (`"removed"`). `"none"` when nothing in the queue is gone.
 */
export function dropFromQueue(gone: GoneSongs): "stopped" | "removed" | "none" {
  const ids = new Set(gone.songIds ?? []);
  const hit = (e: QueueEntry) =>
    ids.has(e.songId) || (gone.projectId !== undefined && e.projectId === gone.projectId);
  const s = useListen.getState();
  if (!s.queue.some(hit)) return "none";
  const cur = currentEntry(s);
  if (cur && hit(cur)) {
    stop();
    return "stopped";
  }
  const queue = s.queue.filter((e) => !hit(e));
  useListen.setState({ queue, index: cur ? Math.max(0, queue.indexOf(cur)) : 0 });
  return "removed";
}

/** Interpolated current time for smooth playheads (rAF), without React state. */
export function currentTime(): number {
  if (pendingTime !== null) return pendingTime;
  return audio?.currentTime ?? useListen.getState().position;
}

// --- Approximate section loop (SPEC §6.10: ±50 ms via timeupdate + rAF checks) ---------------

let loopRange: { songId: string; start: number; end: number } | null = null;
let loopRaf = 0;

/** Loops a range of `songId` while it is the playing song (null clears). */
export function setListenLoop(songId: string, range: { start: number; end: number } | null): void {
  loopRange = range ? { songId, ...range } : null;
  startLoopWatch();
}

/** rAF boundary checks while a loop is set and audio plays (restarted by the `play` event). */
function startLoopWatch(): void {
  if (!loopRange || loopRaf || !audio || audio.paused) return;
  if (typeof requestAnimationFrame === "undefined") return;
  const tick = () => {
    checkLoopBoundary();
    loopRaf = loopRange && audio && !audio.paused ? requestAnimationFrame(tick) : 0;
  };
  loopRaf = requestAnimationFrame(tick);
}

function loopActive(): boolean {
  const s = useListen.getState();
  return loopRange !== null && currentEntry(s)?.songId === loopRange.songId;
}

function checkLoopBoundary(): void {
  if (!loopRange || !audio || audio.paused || !loopActive()) return;
  const t = audio.currentTime;
  if (t >= loopRange.end - 0.01) audio.currentTime = loopRange.start;
}

// --- Media Session --------------------------------------------------------------------------

function installMediaSession(): void {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => void audio?.play()],
    ["pause", () => audio?.pause()],
    ["previoustrack", previous],
    ["nexttrack", next],
    [
      "seekbackward",
      (d) => {
        seek(currentTime() - (d.seekOffset ?? 10));
      },
    ],
    [
      "seekforward",
      (d) => {
        seek(currentTime() + (d.seekOffset ?? 10));
      },
    ],
    [
      "seekto",
      (d) => {
        if (d.seekTime !== undefined) seek(d.seekTime);
      },
    ],
  ];
  for (const [action, handler] of handlers) {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      // action not supported on this browser
    }
  }
}

function updateMetadata(entry: QueueEntry): void {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: entry.title,
    artist: entry.projectName,
    album: entry.subtitle || entry.projectName,
    artwork: entry.imageHash
      ? [
          {
            src: new URL(blobUrl(entry.imageHash), document.baseURI).href,
            sizes: "512x512",
            type: "image/webp",
          },
        ]
      : [],
  });
}

function setPlaybackState(state: MediaSessionPlaybackState): void {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state;
}

function updatePositionState(force: boolean): void {
  if (!("mediaSession" in navigator) || !audio) return;
  const now = Date.now();
  if (!force && now - lastPositionState < 1000) return;
  lastPositionState = now;
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  if (duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.min(audio.currentTime, duration),
      playbackRate: audio.playbackRate,
    });
  } catch {
    // invalid state during source changes
  }
}

/** For tests: drop the singleton. */
export function resetListenEngineForTests(): void {
  audio = null;
  loopRange = null;
  pendingTime = null;
  if (loopRaf && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(loopRaf);
  loopRaf = 0;
}
