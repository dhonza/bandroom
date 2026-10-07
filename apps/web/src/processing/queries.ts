import { getProcessing, type Processing } from "@bandroom/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

export const processingKey = ["processing"] as const;

/** Queued or running work (failures alone are not "active"). */
export function isActive(p: Processing | undefined): boolean {
  return p !== undefined && (p.queued > 0 || p.processing > 0 || p.mix !== null);
}

/** Polling interval while something is being processed (SSE refreshes the rest). */
export const ACTIVE_POLL_MS = 5000;

/** Songs with media work and (admins) running imports, for the header (SPEC §25.3). */
export function useProcessing(enabled = true) {
  return useQuery({
    queryKey: processingKey,
    queryFn: ({ signal }) => api(getProcessing, undefined, { signal }),
    enabled,
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && (d.imports.length > 0 || d.songs.some((s) => isActive(s.processing)))
        ? ACTIVE_POLL_MS
        : false;
    },
  });
}
