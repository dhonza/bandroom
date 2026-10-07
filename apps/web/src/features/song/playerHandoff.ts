import type { ListenSource, Song } from "@bandroom/shared";
import { currentTime, pause, playQueue, seek } from "../../player/listenEngine";
import { useListen, type QueueEntry } from "../../player/listenStore";
import { toQueueEntries } from "../../player/queue";
import { prepareEngine, releasePlayback, setPendingStart } from "../../rehearse/controller";

type SongInfo = Pick<Song, "id" | "title" | "subtitle" | "project">;

/**
 * The project queue with this song's entry using the freshest mix source; without the queue
 * (not loaded, or not available), the song on its own.
 */
export function songQueue(
  song: SongInfo,
  src: ListenSource,
  queue: readonly QueueEntry[] | undefined,
): { items: QueueEntry[]; index: number } {
  const items = queue?.some((q) => q.songId === song.id)
    ? queue.map((q) => (q.songId === song.id ? { ...q, listen: src } : q))
    : toQueueEntries(
        [{ songId: song.id, title: song.title, subtitle: song.subtitle, listen: src }],
        song.project,
      );
  return {
    items,
    index: Math.max(
      0,
      items.findIndex((q) => q.songId === song.id),
    ),
  };
}

/**
 * Starts the mix player at this song so lock-screen next/previous move between the project's
 * songs. Synchronous on purpose: `play()` must run inside the tap for iOS (see useProjectQueue).
 */
export function startMix(
  song: SongInfo,
  src: ListenSource,
  queue: readonly QueueEntry[] | undefined,
  startAt: number,
  autoplay: boolean,
): void {
  const { items, index } = songQueue(song, src, queue);
  playQueue(items, index, { startAt, autoplay });
}

function mixState(songId: string): { current: boolean; playing: boolean } {
  const s = useListen.getState();
  const current = s.queue[s.index]?.songId === songId;
  return { current, playing: current && (s.status === "playing" || s.status === "loading") };
}

/**
 * Mixer on: the multitrack engine takes over this song at the mix player's position, playing if
 * the mix was playing. Call inside the tap (iOS unlocks the AudioContext there).
 */
export function openMixer(songId: string): void {
  const mix = mixState(songId);
  const at = mix.current ? currentTime() : 0;
  if (mix.current) pause();
  prepareEngine();
  if (mix.current) setPendingStart(songId, at, mix.playing);
}

/**
 * Mixer off: the mix player takes over at the engine's position, playing if the engine was (or
 * `play`). Call inside the tap (iOS only starts `<audio>` from a gesture).
 */
export function closeMixer(
  song: SongInfo,
  src: ListenSource,
  queue: readonly QueueEntry[] | undefined,
  opts: { play?: boolean } = {},
): void {
  const engine = releasePlayback(song.id);
  const play = opts.play ?? engine.playing;
  const mix = mixState(song.id);
  if (play) {
    startMix(song, src, queue, engine.atSec, true);
  } else if (mix.current) {
    seek(engine.atSec);
  } else if (engine.atSec > 0 && useListen.getState().status !== "playing") {
    // Cue the song where the engine was, without stopping another song that is playing.
    startMix(song, src, queue, engine.atSec, false);
  }
}
