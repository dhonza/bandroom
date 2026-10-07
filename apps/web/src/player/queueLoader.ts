import {
  getProjectQueue,
  getSong,
  getSongMixer,
  getSongTempo,
  listSongTracks,
  listTrackVersions,
  type MixerState,
  type Song,
  type SongTempo,
  type Track,
  type TrackVersion,
} from "@bandroom/shared";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { queueKey, songKeys } from "../features/library/queries";
import { isLinkMode, loadLocalMix } from "../links/linkMode";
import { useOffline } from "../offline/controller";
import { pendingMixer } from "../offline/pending";
import { tempoKeys } from "../tempo/queries";
import type { QueueEntry } from "./queue";

/** The personal mix and its snapshots, as the Player and the queue read them. */
export async function fetchSongMixer(songId: string, signal?: AbortSignal): Promise<SongMixer> {
  // Link visitors have no account: their mix is kept in this browser.
  if (isLinkMode()) return { state: loadLocalMix(songId), snapshots: [] };
  const r = await fetchServerMixer(songId, signal);
  // A mix changed offline and not sent yet wins (SPEC §13 outbox).
  return { ...r, state: pendingMixer(useOffline.getState().outbox, songId) ?? r.state };
}

function fetchServerMixer(songId: string, signal?: AbortSignal) {
  return api(getSongMixer, { params: { id: songId } }, { signal });
}

type SongMixer = Awaited<ReturnType<typeof fetchServerMixer>>;

/** Tracks whose personal listened version is not the current one need that version's data. */
export function tracksNeedingVersions(tracks: readonly Track[], saved: MixerState | null): Track[] {
  return tracks.filter((tr) => {
    const id = saved?.tracks[tr.id]?.listenedVersionId;
    return id && id !== tr.current?.id;
  });
}

/** Everything the engine needs to play a song of the queue (SPEC §6.10). */
export interface LoadedSong {
  song: Song;
  tracks: Track[];
  saved: MixerState | null;
  listened: Record<string, TrackVersion | undefined>;
  tempo: SongTempo | null;
}

/** Loads a queued song; the app and the public-link view each bring their own. */
export interface QueueLoader {
  load(songId: string): Promise<LoadedSong>;
  /** The project's queue now (`getProjectQueue`): songs may have become ready since the start. */
  entries(projectId: string): Promise<QueueEntry[]>;
}

/**
 * The loader on a query cache, with the song page's query keys and functions: a song the queue
 * loaded opens on its page from the cache, with the same audio (no reload). The public-link view
 * passes its own cache; in link mode the same contracts go to the link endpoints (`api`) and the
 * mix comes from this browser.
 */
export function queryQueueLoader(qc: QueryClient): QueueLoader {
  return {
    async entries(projectId) {
      const r = await qc.query({
        queryKey: queueKey(projectId),
        queryFn: ({ signal }) =>
          api(getProjectQueue, { params: { id: projectId } }, { signal }).then((x) => x.items),
      });
      return r;
    },
    async load(songId) {
      const [song, tracks, mixer, tempo] = await Promise.all([
        qc.query({
          queryKey: songKeys.detail(songId),
          queryFn: ({ signal }) => api(getSong, { params: { id: songId } }, { signal }),
        }),
        qc.query({
          queryKey: songKeys.tracks(songId),
          queryFn: ({ signal }) => api(listSongTracks, { params: { id: songId } }, { signal }),
        }),
        qc.query({
          queryKey: songKeys.mixer(songId),
          queryFn: ({ signal }) => fetchSongMixer(songId, signal),
        }),
        qc
          .query({
            queryKey: tempoKeys.tempo(songId),
            queryFn: ({ signal }) => api(getSongTempo, { params: { id: songId } }, { signal }),
          })
          .then((r) => r.tempo)
          // Without a tempo map the song plays without click and count-in.
          .catch(() => null),
      ]);
      const saved = mixer.state;
      const listened: Record<string, TrackVersion | undefined> = {};
      await Promise.all(
        tracksNeedingVersions(tracks.tracks, saved).map(async (tr) => {
          const r = await qc
            .query({
              queryKey: songKeys.versions(songId, tr.id),
              queryFn: ({ signal }) =>
                api(listTrackVersions, { params: { id: tr.id } }, { signal }),
            })
            .catch(() => null);
          const id = saved?.tracks[tr.id]?.listenedVersionId;
          listened[tr.id] = r?.versions.find((v) => v.id === id);
        }),
      );
      return { song: song.song, tracks: tracks.tracks, saved, listened, tempo };
    },
  };
}
