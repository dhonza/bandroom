import {
  beatQuarters,
  beatsPerBar,
  gridLines,
  tempoAt,
  type GridResolution,
  type TempoGrid,
} from "@bandroom/shared";
import type { ClickLane } from "./clickLane";
import { pickLevel, rangePeak, type Pyramid } from "./peaks";
import type { TimelineMark, TimeRange } from "./types";
import { formatRuler, rulerStep, secToX, xToSec, type View } from "./view";

export interface Lane {
  id: string;
  color: string;
  /** Timeline offset of the audio (48 kHz samples). */
  offsetSamples: number;
  peaks: Pyramid | null;
  /** Drawn faintly (muted or not audible because of solo). */
  dimmed?: boolean;
  /** Amplitude factor: the playing version's gain (SPEC §25.6); peaks clip at the lane edges. */
  scale?: number;
  /** Lane background tinted with the lane color (track lanes, SPEC §25.10). */
  tint?: boolean;
  /** The click lane (SPEC §11.3): ticks from the tempo map instead of a waveform. */
  click?: ClickLane;
}

const colorCache = new Map<string, string>();

/**
 * Resolves a Mantine CSS variable to a color usable in canvas. Cached per color scheme:
 * `getComputedStyle` is too slow to call for every lane and frame.
 */
export function cssColor(name: string, fallback = "#888"): string {
  const root = document.documentElement;
  const key = `${root.getAttribute("data-mantine-color-scheme") ?? ""}|${name}`;
  let v = colorCache.get(key);
  if (v === undefined) {
    v = getComputedStyle(root).getPropertyValue(name).trim();
    if (v) colorCache.set(key, v); // not before the stylesheet has loaded
  }
  return v || fallback;
}

/** Prepares a canvas for crisp drawing at devicePixelRatio; returns the 2D context. */
export function setupCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  // Style writes only on a size change (this runs every animation frame for the playhead).
  const cssW = `${width}px`;
  const cssH = `${height}px`;
  if (canvas.style.width !== cssW) canvas.style.width = cssW;
  if (canvas.style.height !== cssH) canvas.style.height = cssH;
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Strength of the track colour tint behind strip headers and lanes (SPEC §25.10). */
export const TINT_ALPHA = 0.12;

/** CSS background of a track colour tint (the same strength as the lane's canvas tint). */
export function trackTint(color: string): string {
  return `color-mix(in srgb, var(--mantine-color-${color}-6) ${TINT_ALPHA * 100}%, transparent)`;
}

/** A lane's background tinted with its color (SPEC §25.10). */
export function drawLaneTint(
  ctx: CanvasRenderingContext2D,
  width: number,
  y: number,
  h: number,
  color: string,
): void {
  ctx.globalAlpha = TINT_ALPHA;
  ctx.fillStyle = color;
  ctx.fillRect(0, y, width, h);
  ctx.globalAlpha = 1;
}

/** Waveform of one lane: one min/max column per CSS pixel from the pyramid (SPEC §11.6). */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  view: View,
  lane: Lane,
  y: number,
  h: number,
  color: string,
): void {
  const p = lane.peaks;
  if (!p) return;
  const offsetSec = lane.offsetSamples / 48_000;
  const samplesPerPx = p.sampleRate / view.pxPerSec;
  const level = pickLevel(p, samplesPerPx);
  const mid = y + h / 2;
  const scale = ((h / 2 - 1) / 128) * (lane.scale ?? 1);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.75; // SPEC §11.5: ~70 % opacity
  for (let x = 0; x < view.widthPx; x++) {
    const t0 = xToSec(view, x) - offsetSec;
    const t1 = xToSec(view, x + 1) - offsetSec;
    if (t1 <= 0) continue;
    const pk = rangePeak(level, t0 * p.sampleRate, t1 * p.sampleRate);
    if (!pk) continue;
    const [top, bottom, clipped] = clipColumn(mid - pk[1] * scale, mid - pk[0] * scale, y, y + h);
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    if (clipped) {
      // Louder than the lane: solid caps at the edges show where it clips.
      ctx.globalAlpha = 1;
      if (top <= y) ctx.fillRect(x, y, 1, 2);
      if (bottom >= y + h) ctx.fillRect(x, y + h - 2, 1, 2);
      ctx.globalAlpha = 0.75;
    }
  }
  ctx.globalAlpha = 1;
}

/** A waveform column limited to the lane `[y0, y1]`; `clipped` when it reached an edge. */
export function clipColumn(
  top: number,
  bottom: number,
  y0: number,
  y1: number,
): [top: number, bottom: number, clipped: boolean] {
  const t = Math.max(y0, Math.min(y1, top));
  const b = Math.max(y0, Math.min(y1, bottom));
  return [t, b, t !== top || b !== bottom];
}

export function drawRuler(
  ctx: CanvasRenderingContext2D,
  view: View,
  h: number,
  colors: { text: string; line: string },
): void {
  const step = rulerStep(view.pxPerSec);
  const first = Math.ceil(view.startSec / step) * step;
  ctx.fillStyle = colors.text;
  ctx.strokeStyle = colors.line;
  ctx.font = "11px Inter Variable, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let t = first; t <= view.startSec + view.widthPx / view.pxPerSec + step; t += step) {
    const x = Math.round(secToX(view, t)) + 0.5;
    ctx.moveTo(x, h - 6);
    ctx.lineTo(x, h);
    ctx.fillText(formatRuler(t, step), x + 3, h / 2 - 1);
  }
  ctx.stroke();
}

/** Grid resolution for the zoom: the finest level whose lines are at least `minPx` apart. */
export function gridResolution(grid: TempoGrid, view: View, minPx = 10): GridResolution | null {
  const mid = view.startSec + view.widthPx / view.pxPerSec / 2;
  const { bpm, meter } = tempoAt(grid, mid);
  const beatPx = ((beatQuarters(meter) * 60) / bpm) * view.pxPerSec;
  if (beatPx / 4 >= minPx) return "quarter";
  if (beatPx / 2 >= minPx) return "half";
  if (beatPx >= minPx) return "beat";
  if (beatPx * beatsPerBar(meter) >= 4) return "bar";
  return null;
}

/**
 * Musical grid (SPEC §11.6): bar lines, beats and subdivisions with density adapted to the zoom,
 * and bar numbers in the ruler (bars.beats when zoomed in). Pickup bars are numbered 0, −1, ….
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  view: View,
  grid: TempoGrid,
  rulerH: number,
  bottom: number,
  colors: { text: string; line: string; bar: string },
): void {
  const res = gridResolution(grid, view);
  if (!res) return;
  const from = view.startSec;
  const to = view.startSec + view.widthPx / view.pxPerSec;
  const lines = gridLines(grid, from, to, res);
  const bars = lines.filter((l) => l.level === 0);
  // Label every k-th bar so labels are ≥ 44 px apart.
  const barPx = bars.length > 1 ? ((bars[1]?.sec ?? 0) - (bars[0]?.sec ?? 0)) * view.pxPerSec : 1e9;
  const every = [1, 2, 4, 8, 16, 32, 64].find((k) => k * barPx >= 44) ?? 128;
  const beatLabels = res !== "bar" && res !== "beat" ? true : barPx / 4 >= 44 && res === "beat";
  ctx.lineWidth = 1;
  ctx.font = "11px Inter Variable, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  let beatInBar = 0;
  let lastBar = Number.NaN;
  for (const l of lines) {
    const x = Math.round(secToX(view, l.sec)) + 0.5;
    if (l.bar !== lastBar) {
      lastBar = l.bar;
      beatInBar = 0;
    }
    if (l.level !== 2) beatInBar++;
    if (x < 0 || x > view.widthPx) continue;
    ctx.globalAlpha = l.level === 0 ? 0.45 : l.level === 1 ? 0.2 : 0.09;
    ctx.strokeStyle = l.level === 0 ? colors.bar : colors.line;
    ctx.beginPath();
    ctx.moveTo(x, l.level === 0 ? 0 : rulerH - (l.level === 1 ? 8 : 4));
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.text;
    if (l.level === 0 && (((l.bar - 1) % every) + every) % every === 0) {
      ctx.fillText(String(l.bar), x + 3, rulerH / 2 - 1);
    } else if (l.level === 1 && beatLabels) {
      ctx.globalAlpha = 0.7;
      ctx.fillText(`${l.bar}.${beatInBar}`, x + 3, rulerH / 2 - 1);
      ctx.globalAlpha = 1;
    }
  }
}

/** Marker guides as faint vertical lines from `top` to `bottom`. */
export function drawGuides(
  ctx: CanvasRenderingContext2D,
  view: View,
  guides: readonly TimelineMark[],
  top: number,
  bottom: number,
): void {
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  for (const g of guides) {
    const x = Math.round(secToX(view, g.start)) + 0.5;
    if (x < 0 || x > view.widthPx) continue;
    ctx.strokeStyle = cssColor(`--mantine-color-${g.color}-5`);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * The lanes the overview sums (SPEC §11.3): the audible ones; muted lanes and lanes silenced by a
 * solo are left out, so the overview shows the personal mix. The click lane is never in it.
 */
export function overviewLanes<L extends Pick<Lane, "dimmed" | "click">>(lanes: readonly L[]): L[] {
  return lanes.filter((l) => !l.dimmed && !l.click);
}

/** Overview strip content: section bands, the audible lanes' waveforms and the loop range. */
export function drawOverview(
  ctx: CanvasRenderingContext2D,
  all: View,
  h: number,
  content: {
    bands: readonly TimelineMark[];
    lanes: readonly Lane[];
    range: TimeRange | null | undefined;
    rangeColor: string;
  },
): void {
  ctx.globalAlpha = 0.28;
  for (const b of content.bands) {
    const x0 = secToX(all, b.start);
    const x1 = secToX(all, b.end ?? b.start);
    ctx.fillStyle = cssColor(`--mantine-color-${b.color}-6`);
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
  }
  ctx.globalAlpha = 1;
  for (const lane of overviewLanes(content.lanes))
    drawWaveform(ctx, all, lane, 2, h - 4, cssColor(`--mantine-color-${lane.color}-5`));
  const range = content.range;
  if (range) {
    const x0 = secToX(all, range.start);
    const x1 = secToX(all, range.end);
    ctx.fillStyle = cssColor(`--mantine-color-${content.rangeColor}-4`);
    ctx.globalAlpha = 0.25;
    ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);
    ctx.globalAlpha = 1;
    ctx.fillRect(x0, 0, 2, h);
    ctx.fillRect(Math.max(x0, x1 - 2), 0, 2, h);
  }
}

/** The visible part of the detail view as a box on the overview strip. */
export function drawViewportBox(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  h: number,
): void {
  ctx.strokeStyle = cssColor("--mantine-color-text");
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x0 + 0.75, 0.75, Math.max(4, x1 - x0) - 1.5, h - 1.5);
}

/** The playhead line at `x` across the detail view. */
export function drawPlayheadLine(
  ctx: CanvasRenderingContext2D,
  x: number,
  h: number,
  color: string,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, h);
  ctx.stroke();
}
