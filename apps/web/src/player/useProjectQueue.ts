import { getProjectQueue } from "@bandroom/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../api/client";
import { queueKey } from "../features/library/queries";
import { queryQueueLoader, type QueueLoader } from "./queueLoader";

/**
 * The project's playable songs for the engine queue (SPEC §6.10), loaded with the page. Play
 * buttons read it synchronously: the audio is unlocked inside the tap (iOS), before any fetch.
 */
export function useProjectQueue(projectId: string) {
  return useQuery({
    queryKey: queueKey(projectId),
    queryFn: ({ signal }) =>
      api(getProjectQueue, { params: { id: projectId } }, { signal }).then((r) => r.items),
    staleTime: 10_000,
    enabled: projectId !== "",
  });
}

/** The queue loader on this view's query cache (the app's, or the public link's own). */
export function useQueueLoader(): QueueLoader {
  const qc = useQueryClient();
  return useMemo(() => queryQueueLoader(qc), [qc]);
}
