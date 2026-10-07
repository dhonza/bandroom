/** Keyboard zoom (`+`/`−`, SPEC §11.4) from the page-level shortcut handler. */
export const ZOOM_EVENT = "bandroom:timeline-zoom";

export function requestZoom(factor: number): void {
  window.dispatchEvent(new CustomEvent(ZOOM_EVENT, { detail: factor }));
}

/** `Z`: zoom the timeline to the loop or selection (SPEC §25.8). */
export const ZOOM_RANGE_EVENT = "bandroom:timeline-zoom-range";

export function requestZoomToRange(): void {
  window.dispatchEvent(new Event(ZOOM_RANGE_EVENT));
}

export function onZoomToRangeRequest(cb: () => void): () => void {
  window.addEventListener(ZOOM_RANGE_EVENT, cb);
  return () => {
    window.removeEventListener(ZOOM_RANGE_EVENT, cb);
  };
}

/** Calls `onZoom` with each requested zoom factor; returns the unsubscribe function. */
export function onZoomRequest(onZoom: (factor: number) => void): () => void {
  const listener = (e: Event) => {
    const f = (e as CustomEvent<number>).detail;
    if (typeof f === "number") onZoom(f);
  };
  window.addEventListener(ZOOM_EVENT, listener);
  return () => {
    window.removeEventListener(ZOOM_EVENT, listener);
  };
}
