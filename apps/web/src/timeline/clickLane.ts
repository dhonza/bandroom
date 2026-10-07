import { clickPulses, type ClickOptions, type TempoGrid } from "@bandroom/shared";
import { secToX, type View } from "./view";

/**
 * The click lane of the Mixer (SPEC §11.3, DECISIONS 2026-10-07): one tick per click pulse,
 * drawn from the tempo map with the personal click settings, so the lane shows what the click
 * plays. Downbeats are accented (taller) when the click accents them.
 */
export interface ClickLane extends ClickOptions {
  grid: TempoGrid;
  accent: boolean;
}

export interface ClickTick {
  sec: number;
  /** 0 = accented downbeat, 1 = beat, 2 = subdivision (as the click plays it). */
  level: 0 | 1 | 2;
}

/** Ticks closer than this (CSS px) are thinned out: subdivisions first, then beats. */
export const MIN_TICK_PX = 4;

/**
 * The ticks between two song positions at `pxPerSec`. Too dense levels are left out (bars stay),
 * so a zoomed-out lane does not turn into a solid block.
 */
export function clickLaneTicks(
  lane: ClickLane,
  fromSec: number,
  toSec: number,
  pxPerSec: number,
): ClickTick[] {
  const pulses = clickPulses(lane.grid, fromSec, toSec, lane);
  const gap = (level: number) => {
    let min = Infinity;
    let last = Number.NaN;
    for (const p of pulses) {
      if (p.level > level) continue;
      if (!Number.isNaN(last)) min = Math.min(min, (p.sec - last) * pxPerSec);
      last = p.sec;
    }
    return min;
  };
  const maxLevel = gap(2) >= MIN_TICK_PX ? 2 : gap(1) >= MIN_TICK_PX ? 1 : 0;
  return pulses
    .filter((p) => p.level <= maxLevel)
    .map((p) => ({ sec: p.sec, level: p.level === 0 && !lane.accent ? 1 : p.level }));
}

/** Draws the lane's ticks into `[y, y + h]`: downbeats full height, beats ⅔, subdivisions ⅓. */
export function drawClickLane(
  ctx: CanvasRenderingContext2D,
  view: View,
  lane: ClickLane,
  y: number,
  h: number,
  color: string,
  /** Opacity of the whole lane (a muted click is drawn faintly). */
  opacity = 1,
): void {
  const ticks = clickLaneTicks(
    lane,
    view.startSec,
    view.startSec + view.widthPx / view.pxPerSec,
    view.pxPerSec,
  );
  ctx.fillStyle = color;
  const mid = y + h / 2;
  for (const t of ticks) {
    const x = Math.round(secToX(view, t.sec));
    const len = (h - 6) * (t.level === 0 ? 1 : t.level === 1 ? 0.66 : 0.33);
    ctx.globalAlpha = opacity * (t.level === 2 ? 0.55 : 0.9);
    ctx.fillRect(x, mid - len / 2, t.level === 0 ? 3 : 2, Math.max(2, len));
  }
  ctx.globalAlpha = 1;
}
