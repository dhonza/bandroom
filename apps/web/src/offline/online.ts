import { create } from "zustand";

/**
 * Network state for the offline indicator and the outbox (SPEC §13). `navigator.onLine` is only a
 * hint (true on a network without internet), so a failed request can also mark us offline until
 * the next successful one or the browser's `online` event.
 */
interface OnlineState {
  online: boolean;
}

export const useOnlineState = create<OnlineState>(() => ({
  online: typeof navigator === "undefined" ? true : navigator.onLine,
}));

export function isOnline(): boolean {
  return useOnlineState.getState().online;
}

export function useOnline(): boolean {
  return useOnlineState((s) => s.online);
}

export function reportNetworkFailure(): void {
  useOnlineState.setState({ online: false });
}

export function reportNetworkSuccess(): void {
  if (!useOnlineState.getState().online) useOnlineState.setState({ online: true });
}

const listeners = new Set<() => void>();

/** Called whenever the app comes back online (outbox replay, offline refresh). */
export function onReconnect(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let installed = false;

export function watchOnlineState(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("online", () => {
    useOnlineState.setState({ online: true });
  });
  window.addEventListener("offline", () => {
    useOnlineState.setState({ online: false });
  });
  useOnlineState.subscribe((s, prev) => {
    if (s.online && !prev.online) for (const fn of listeners) fn();
  });
  // Marked offline by a failed request while the browser thinks it is online: probe now and then.
  window.setInterval(() => {
    if (useOnlineState.getState().online || !navigator.onLine) return;
    fetch(new URL("healthz", document.baseURI).href, { cache: "no-store" })
      .then((res) => {
        if (res.ok) reportNetworkSuccess();
      })
      .catch(() => undefined);
  }, 15_000);
}
