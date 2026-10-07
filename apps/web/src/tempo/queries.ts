import {
  deleteSongTempo,
  getSongTempo,
  importSongTempoMidi,
  listTempoRevisions,
  putSongTempo,
  restoreTempoRevision,
  type TempoMap,
} from "@bandroom/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { api } from "../api/client";
import { markerKeys } from "../markers/queries";
import { setSongTempo } from "./store";

export const tempoKeys = {
  tempo: (songId: string) => ["songs", songId, "tempo"] as const,
  revisions: (songId: string) => ["songs", songId, "tempo", "revisions"] as const,
};

/** The song's tempo map, mirrored into the tempo store for the timeline and the engine. */
export function useSongTempo(songId: string) {
  const q = useQuery({
    queryKey: tempoKeys.tempo(songId),
    queryFn: ({ signal }) => api(getSongTempo, { params: { id: songId } }, { signal }),
  });
  const tempo = q.data?.tempo ?? null;
  useEffect(() => {
    if (q.data) setSongTempo(songId, q.data.tempo);
  }, [songId, q.data]);
  return { ...q, tempo };
}

export function useTempoRevisions(songId: string, enabled: boolean) {
  return useQuery({
    queryKey: tempoKeys.revisions(songId),
    queryFn: ({ signal }) => api(listTempoRevisions, { params: { id: songId } }, { signal }),
    enabled,
  });
}

/** Base64 without spreading large arrays into one call. */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Tempo changes (editors); every action refreshes the tempo, its history and the markers. */
export function useTempoActions(songId: string) {
  const qc = useQueryClient();
  const refresh = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: tempoKeys.tempo(songId) }),
      qc.invalidateQueries({ queryKey: markerKeys.list(songId) }),
    ]);
  }, [qc, songId]);
  return useMemo(
    () => ({
      save: async (map: TempoMap, bar1OffsetSec: number) => {
        await api(putSongTempo, { params: { id: songId }, body: { map, bar1OffsetSec } });
        await refresh();
      },
      importMidi: async (fileName: string, bytes: Uint8Array, markers: number[]) => {
        const r = await api(importSongTempoMidi, {
          params: { id: songId },
          body: { fileName, data: toBase64(bytes), markers },
        });
        await refresh();
        return r.markersCreated;
      },
      remove: async () => {
        await api(deleteSongTempo, { params: { id: songId } });
        await refresh();
      },
      restore: async (revisionId: string) => {
        await api(restoreTempoRevision, { params: { id: songId, revisionId } });
        await refresh();
      },
    }),
    [songId, refresh],
  );
}
