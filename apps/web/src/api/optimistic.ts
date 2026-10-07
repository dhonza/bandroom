import type { QueryClient, QueryKey, Updater } from "@tanstack/react-query";

/**
 * Optimistic cache write (SPEC §11.1): cancels any in-flight fetch of `key` first, so a refetch
 * started before the change (e.g. by our own SSE echo) cannot land afterwards and briefly undo it.
 * Cancelling reverts the query synchronously, so the write stays instant.
 */
export function setOptimistic<T>(
  qc: QueryClient,
  key: QueryKey,
  updater: Updater<T | undefined, T | undefined>,
): void {
  void qc.cancelQueries({ queryKey: key, exact: true });
  qc.setQueryData<T>(key, updater);
}
