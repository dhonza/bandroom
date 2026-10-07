import {
  getProject,
  listProjects,
  listProjectSongs,
  getSong,
  listSongTracks,
} from "@bandroom/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { ACTIVE_POLL_MS, isActive } from "../../processing/queries";

export const projectKeys = {
  all: ["projects"] as const,
  list: (archived: boolean) => ["projects", "list", archived] as const,
  detail: (id: string) => ["projects", "detail", id] as const,
  songs: (id: string) => ["projects", "detail", id, "songs"] as const,
  grants: (id: string) => ["projects", "detail", id, "grants"] as const,
};

export const songKeys = {
  detail: (id: string) => ["songs", id] as const,
  grants: (id: string) => ["songs", id, "grants"] as const,
  tracks: (id: string) => ["songs", id, "tracks"] as const,
  allVersions: (songId: string) => ["songs", songId, "versions"] as const,
  versions: (songId: string, trackId: string) => ["songs", songId, "versions", trackId] as const,
  mixer: (id: string) => ["songs", id, "mixer"] as const,
};

export const queueKey = (projectId: string) => ["projects", "detail", projectId, "queue"] as const;

export function useProjects(archived: boolean) {
  return useQuery({
    queryKey: projectKeys.list(archived),
    queryFn: ({ signal }) =>
      api(listProjects, { query: { archived: archived ? "true" : "false" } }, { signal }),
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: projectKeys.detail(id),
    queryFn: ({ signal }) => api(getProject, { params: { id } }, { signal }),
  });
}

export function useProjectSongs(id: string) {
  return useQuery({
    queryKey: projectKeys.songs(id),
    queryFn: ({ signal }) => api(listProjectSongs, { params: { id } }, { signal }),
    // Badges follow ingest progress while something is processed (SPEC §25.3).
    refetchInterval: (q) =>
      q.state.data?.songs.some((s) => isActive(s.processing)) ? ACTIVE_POLL_MS : false,
  });
}

export function useSong(id: string) {
  return useQuery({
    queryKey: songKeys.detail(id),
    queryFn: ({ signal }) => api(getSong, { params: { id } }, { signal }),
  });
}

export function useSongTracks(songId: string) {
  return useQuery({
    queryKey: songKeys.tracks(songId),
    queryFn: ({ signal }) => api(listSongTracks, { params: { id: songId } }, { signal }),
  });
}

/** Content changes affect lists, details and counts: refresh everything project/song related. */
export function useInvalidateContent() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: projectKeys.all });
    void qc.invalidateQueries({ queryKey: ["songs"] });
  };
}
