/** Timeline viewport math (pure). Time is in seconds on the song timeline. */
export interface View {
  startSec: number;
  pxPerSec: number;
  widthPx: number;
  durationSec: number;
}

/** Closest zoom: ~2000 px/s (below 24 samples per pixel at 48 kHz, peaks are stretched). */
export const MAX_PX_PER_SEC = 2000;

export function minPxPerSec(v: Pick<View, "widthPx" | "durationSec">): number {
  return v.durationSec > 0 ? v.widthPx / v.durationSec : 1;
}

export function clampView(v: View): View {
  const pxPerSec = Math.min(MAX_PX_PER_SEC, Math.max(minPxPerSec(v), v.pxPerSec));
  const visible = v.widthPx / pxPerSec;
  const startSec = Math.min(Math.max(0, v.startSec), Math.max(0, v.durationSec - visible));
  return { ...v, pxPerSec, startSec };
}

export function fitAll(durationSec: number, widthPx: number): View {
  return clampView({
    startSec: 0,
    pxPerSec: minPxPerSec({ widthPx, durationSec }),
    widthPx,
    durationSec,
  });
}

export const secToX = (v: View, sec: number): number => (sec - v.startSec) * v.pxPerSec;
export const xToSec = (v: View, x: number): number => v.startSec + x / v.pxPerSec;

/** Zooms by `factor` keeping the time under `anchorX` fixed (pinch center / mouse). */
export function zoomAt(v: View, anchorX: number, factor: number): View {
  const anchorSec = xToSec(v, anchorX);
  const pxPerSec = Math.min(MAX_PX_PER_SEC, Math.max(minPxPerSec(v), v.pxPerSec * factor));
  return clampView({ ...v, pxPerSec, startSec: anchorSec - anchorX / pxPerSec });
}

/**
 * The view showing `[start, end]` with a margin of 10 % of its length on each side, at least 1 s,
 * clamped to the song (zoom to loop, SPEC §25.8). Centred when the closest zoom cannot show it all.
 */
export function fitRange(v: View, start: number, end: number): View {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const margin = Math.max(1, (hi - lo) * 0.1);
  const from = Math.max(0, lo - margin);
  const to = Math.min(v.durationSec, hi + margin);
  const wanted = v.widthPx / Math.max(1e-3, to - from);
  const pxPerSec = Math.min(MAX_PX_PER_SEC, Math.max(minPxPerSec(v), wanted));
  const startSec = pxPerSec < wanted ? (lo + hi) / 2 - v.widthPx / pxPerSec / 2 : from;
  return clampView({ ...v, pxPerSec, startSec });
}

export function scrollBy(v: View, dxPx: number): View {
  return clampView({ ...v, startSec: v.startSec + dxPx / v.pxPerSec });
}

/** Keeps the playhead visible: when it passes 85 % of the view, page so it sits at 15 %. */
export function follow(v: View, playheadSec: number): View {
  const x = secToX(v, playheadSec);
  if (x >= 0 && x <= v.widthPx * 0.85) return v;
  return clampView({ ...v, startSec: playheadSec - (v.widthPx * 0.15) / v.pxPerSec });
}

const STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Ruler label step so labels are at least `minPx` apart. */
export function rulerStep(pxPerSec: number, minPx = 70): number {
  return STEPS.find((s) => s * pxPerSec >= minPx) ?? 600;
}

/** m:ss (or m:ss.s for sub-second steps). */
export function formatRuler(sec: number, step: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const ss =
    step < 1
      ? s.toFixed(step < 0.1 ? 2 : 1).padStart(step < 0.1 ? 5 : 4, "0")
      : String(Math.round(s)).padStart(2, "0");
  return `${m}:${ss}`;
}

/** A time clamped to the song. */
export function clampSec(sec: number, durationSec: number): number {
  return Math.max(0, Math.min(durationSec, sec));
}

/** The view scrolled so `sec` is in the middle. */
export function centerOn(v: View, sec: number): View {
  return clampView({ ...v, startSec: sec - v.widthPx / v.pxPerSec / 2 });
}

/** The visible part of `v` on the overview strip (`all`: the whole song at the strip's width). */
export function viewportOn(all: View, v: View): { x0: number; x1: number } {
  return { x0: secToX(all, v.startSec), x1: secToX(all, v.startSec + v.widthPx / v.pxPerSec) };
}

/**
 * Wheel over the detail view: Ctrl/Cmd zooms around the pointer, a horizontal (or Shift)
 * wheel scrolls; null leaves the event to the page.
 */
export function wheelView(
  v: View,
  w: {
    x: number;
    deltaX: number;
    deltaY: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  },
): { view: View; zoom: boolean } | null {
  if (w.ctrlKey || w.metaKey)
    return { view: zoomAt(v, w.x, Math.exp(-w.deltaY * 0.01)), zoom: true };
  if (Math.abs(w.deltaX) > Math.abs(w.deltaY) || w.shiftKey)
    return { view: scrollBy(v, w.shiftKey ? w.deltaY : w.deltaX), zoom: false };
  return null;
}
