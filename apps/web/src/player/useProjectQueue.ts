import { useQuery } from "@tanstack/react-query";
import { queueKey } from "../features/library/queries";
import { fetchProjectQueue } from "./queue";

/**
 * The project's Listen queue, loaded with the page. Play buttons read it synchronously: iOS Safari
 * only starts media from `play()` called inside the tap handler, not after an awaited fetch.
 */
export function useProjectQueue(project: { id: string; name: string; imageHash: string | null }) {
  return useQuery({
    queryKey: queueKey(project.id),
    queryFn: () => fetchProjectQueue(project),
    staleTime: 10_000,
  });
}
