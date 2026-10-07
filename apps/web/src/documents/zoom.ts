/** Zoom range of the PDF and image viewers (1 = fit width). */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 5;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
}

/** Distance between the first two touch points (pinch-zoom). */
export function pinchDistance(points: readonly { x: number; y: number }[]): number {
  const [a, b] = points;
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * How far one "page" scrolls in a long text document (page turner pedal): a screenful minus a
 * little overlap so the reader keeps their place.
 */
export function pageScrollTarget(
  scrollTop: number,
  viewport: number,
  total: number,
  dir: "next" | "prev",
): number {
  const step = Math.max(40, viewport * 0.9);
  const next = dir === "next" ? scrollTop + step : scrollTop - step;
  return Math.min(Math.max(0, next), Math.max(0, total - viewport));
}
