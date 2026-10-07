import {
  getProjectFollow,
  getSongFollow,
  getUnreadNotificationCount,
  listNotifications,
  markNotificationsRead,
  setProjectFollow,
  setSongFollow,
} from "@bandroom/shared";
import { notifications } from "@mantine/notifications";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { setOptimistic } from "../api/optimistic";
import { useApiError } from "../api/useApiError";

export const notificationKeys = {
  all: ["notifications"] as const,
  unread: ["notifications", "unread"] as const,
  list: ["notifications", "list"] as const,
};

/** Unread count for the bell and nav badges; SSE `notification` events invalidate it. */
export function useUnreadCount() {
  return (
    useQuery({
      queryKey: notificationKeys.unread,
      queryFn: ({ signal }) => api(getUnreadNotificationCount, {}, { signal }),
      staleTime: 30_000,
    }).data?.count ?? 0
  );
}

export function useNotificationList() {
  return useInfiniteQuery({
    queryKey: notificationKeys.list,
    queryFn: ({ pageParam, signal }) =>
      api(
        listNotifications,
        { query: { limit: 30, ...(pageParam && { cursor: pageParam }) } },
        { signal },
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[] | "all") =>
      api(markNotificationsRead, { body: ids === "all" ? { all: true } : { ids } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

/** Follow state of a song or project (SPEC §16). */
export function useFollow(target: "song" | "project", id: string) {
  const qc = useQueryClient();
  const apiError = useApiError();
  const key = ["follows", target, id] as const;
  const q = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      target === "song"
        ? api(getSongFollow, { params: { id } }, { signal })
        : api(getProjectFollow, { params: { id } }, { signal }),
  });
  const m = useMutation({
    mutationFn: (following: boolean) =>
      target === "song"
        ? api(setSongFollow, { params: { id }, body: { following } })
        : api(setProjectFollow, { params: { id }, body: { following } }),
    onMutate: (following) => {
      setOptimistic(qc, key, { following });
    },
    // The refetch below puts the toggle back; say why.
    onError: (err) => notifications.show({ color: "red", message: apiError(err) }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  return { following: q.data?.following ?? false, loaded: q.isSuccess, set: m.mutate };
}
