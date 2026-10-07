import {
  SECTION_PRESET_COLORS,
  SECTION_PRESETS,
  snapToGrid,
  stepGrid,
  type GridResolution,
  type Marker,
  type MarkerAnchor,
  type PaletteColor,
  type SectionPreset,
  type TempoGrid,
} from "@bandroom/shared";
import { DOUBLE_TAP_MS } from "../lib/gestures";
import { parseClock } from "../player/format";

/**
 * Timeline editing and navigation logic for markers, sections, selection and loops (SPEC §7.4–
 * §7.6), as pure functions. Times are seconds on the song timeline.
 */

export interface Range {
  start: number;
  end: number;
}

/** Shortest loop (SPEC §7.6). */
export const MIN_LOOP_SEC = 0.25;
/** Shortest selection or section; anything shorter counts as a click. */
export const MIN_SELECTION_SEC = 0.05;
/** Snap threshold in CSS pixels at the current zoom (SPEC §7.5). */
export const SNAP_PX = 12;

/**
 * Snap modes (SPEC §7.5). The musical ones (bar, beat, ½ and ¼ beat) need a tempo map; marker
 * positions and section edges stay snap targets alongside them.
 */
export const SNAP_MODES = ["off", "markers", "bar", "beat", "half", "quarter"] as const;
export type SnapMode = (typeof SNAP_MODES)[number];

export const MUSICAL_SNAP_MODES: readonly GridResolution[] = ["bar", "beat", "half", "quarter"];

/** The grid resolution of a musical snap mode, or null. */
export function musicalSnap(m: SnapMode): GridResolution | null {
  return MUSICAL_SNAP_MODES.find((r) => r === m) ?? null;
}

/** The snap mode in effect: musical modes fall back to markers without a tempo map. */
export function effectiveSnap(m: SnapMode, hasTempo: boolean): SnapMode {
  return !hasTempo && musicalSnap(m) ? "markers" : m;
}

/** `S` cycles off → markers → bar → beat → ½ → ¼ (musical modes only with a tempo map). */
export function nextSnapMode(m: SnapMode, hasTempo = false): SnapMode {
  const modes = SNAP_MODES.filter((x) => hasTempo || !musicalSnap(x));
  const i = modes.indexOf(effectiveSnap(m, hasTempo));
  return modes[(i + 1) % modes.length] ?? "off";
}

export function isSection(m: Marker): m is Marker & { endSec: number } {
  return m.type === "section" && m.endSec !== null;
}

/** Sections by start time (lane breaks ties). */
export function sectionsOf(markers: readonly Marker[]): (Marker & { endSec: number })[] {
  return markers.filter(isSection).sort((a, b) => a.startSec - b.startSec || a.lane - b.lane);
}

/** The section under `sec` (start inclusive, end exclusive), preferring the structure lane. */
export function sectionAt(
  markers: readonly Marker[],
  sec: number,
): (Marker & { endSec: number }) | null {
  let best: (Marker & { endSec: number }) | null = null;
  for (const s of markers) {
    if (!isSection(s) || sec < s.startSec || sec >= s.endSec) continue;
    if (!best || s.lane < best.lane) best = s;
  }
  return best;
}

/** Every marker position and section edge, sorted and de-duplicated (ms precision). */
export function boundaries(markers: readonly Marker[]): number[] {
  const set = new Set<number>();
  for (const m of markers) {
    set.add(Math.round(m.startSec * 1000));
    if (isSection(m)) set.add(Math.round(m.endSec * 1000));
  }
  return [...set].sort((a, b) => a - b).map((ms) => ms / 1000);
}

/**
 * Previous boundary (SPEC §7.6 `[`): the last one more than `tolerance` before `sec`, so a
 * press right after passing a boundary (while playing) goes to the one before it. Song start
 * when there is none.
 */
export function prevBoundary(bounds: readonly number[], sec: number, tolerance = 0.5): number {
  let out = 0;
  for (const b of bounds) if (b < sec - tolerance) out = b;
  return out;
}

/** Next boundary (SPEC §7.6 `]`), or null at the last one. */
export function nextBoundary(bounds: readonly number[], sec: number): number | null {
  for (const b of bounds) if (b > sec + 0.001) return b;
  return null;
}

/**
 * Snapping (SPEC §7.5): the nearest of the marker targets and, in a musical mode, the nearest
 * grid line, within `thresholdSec` (12 px at the current zoom); else `sec` unchanged.
 */
export function snapWith(
  sec: number,
  mode: SnapMode,
  targets: readonly number[],
  thresholdSec: number,
  grid: TempoGrid | null,
): number {
  if (mode === "off") return sec;
  const res = musicalSnap(mode);
  const extra = res && grid ? [snapToGrid(grid, sec, res)] : [];
  return snapSec(sec, extra.length ? [...targets, ...extra] : targets, thresholdSec);
}

/** Nearest target within `thresholdSec` (SPEC §7.5), else `sec` unchanged. */
export function snapSec(sec: number, targets: readonly number[], thresholdSec: number): number {
  let best = sec;
  let dist = thresholdSec;
  for (const t of targets) {
    const d = Math.abs(t - sec);
    if (d <= dist) {
      best = t;
      dist = d;
    }
  }
  return best;
}

export function orderedRange(a: number, b: number): Range {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

export function clampRange(r: Range, duration: number): Range {
  const start = Math.max(0, Math.min(r.start, duration));
  const end = Math.max(start, Math.min(r.end, duration));
  return { start, end };
}

export function isLoopable(r: Range | null): r is Range {
  return r !== null && r.end - r.start >= MIN_LOOP_SEC;
}

/**
 * What the loop toggle (`L`) loops (SPEC §7.6): the selection, else the section under the
 * playhead; null when there is neither (the toggle is disabled).
 */
export function loopTarget(
  selection: Range | null,
  markers: readonly Marker[],
  position: number,
): Range | null {
  if (isLoopable(selection)) return selection;
  const s = sectionAt(markers, position);
  return s ? { start: s.startSec, end: s.endSec } : null;
}

/**
 * "Return to start" (`Enter`, SPEC §7.6): the loop start when looping, else the last play-start
 * position; a second press (within a short time) goes to the song start.
 */
export function returnTarget(
  loop: Range | null,
  lastPlayStart: number | null,
  secondPress: boolean,
): number {
  if (secondPress) return 0;
  return loop?.start ?? lastPlayStart ?? 0;
}

/**
 * Nudge (`←/→`, SPEC §7.6): to the next or previous beat (Shift: bar line) with a tempo map,
 * else 1 s (Shift: 5 s).
 */
export function nudge(
  sec: number,
  dir: -1 | 1,
  big: boolean,
  duration: number,
  grid: TempoGrid | null = null,
): number {
  const to = grid ? stepGrid(grid, sec, dir, big ? "bar" : "beat") : sec + dir * (big ? 5 : 1);
  return Math.max(0, Math.min(duration, to));
}

export function sameRange(a: Range | null, b: Range | null, eps = 0.0005): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a.start - b.start) < eps && Math.abs(a.end - b.end) < eps;
}

/** The section exactly covering the range (selection bar shows "Edit" instead of "Save"). */
export function sectionMatching(markers: readonly Marker[], r: Range | null): Marker | null {
  if (!r) return null;
  return (
    markers.find((m) => isSection(m) && sameRange({ start: m.startSec, end: m.endSec }, r)) ?? null
  );
}

/** Preset matching a (localized or English) name, for its color. */
export function presetForName(
  name: string,
  label: (p: SectionPreset) => string,
): SectionPreset | null {
  const n = name
    .trim()
    .toLowerCase()
    .replace(/\s*\d+$/, "");
  return (
    SECTION_PRESETS.find((p) => label(p).toLowerCase() === n || p === n.replace(/[-\s]/g, "")) ??
    null
  );
}

export function presetColor(p: SectionPreset | null, fallback: PaletteColor): PaletteColor {
  return p ? SECTION_PRESET_COLORS[p] : fallback;
}

/**
 * Name for a new section with preset `label`: "Chorus", then "Chorus 2", "Chorus 3" … counting
 * existing sections that already use it.
 */
export function numberedName(base: string, markers: readonly Marker[]): string {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: (\\d+))?$`, "i");
  let n = 0;
  for (const m of markers) {
    const hit = re.exec(m.name);
    if (hit) n = Math.max(n, hit[1] ? Number(hit[1]) : 1);
  }
  return n === 0 ? base : `${base} ${n + 1}`;
}

/** Stable order for display: by start, markers after sections at the same time. */
export function byStart(a: Marker, b: Marker): number {
  return a.startSec - b.startSec || (a.type === b.type ? 0 : a.type === "section" ? -1 : 1);
}

/** A tap within the double-tap window on the same item as the last one (SPEC §7.6 two-tap rule). */
export function isDoubleTap(
  last: { id: string; at: number } | null,
  id: string,
  now: number,
): boolean {
  return last?.id === id && now - last.at < DOUBLE_TAP_MS;
}

/** Sections on the first lane as colored bands on the overview strip. */
export function bandsOf(
  markers: readonly Marker[],
): { start: number; end: number; color: string }[] {
  return sectionsOf(markers)
    .filter((s) => s.lane === 0)
    .map((s) => ({ start: s.startSec, end: s.endSec, color: s.color }));
}

/** Point markers as vertical guides on the overview strip. */
export function guidesOf(markers: readonly Marker[]): { start: number; color: string }[] {
  return markers
    .filter((m) => m.type === "marker")
    .map((m) => ({ start: m.startSec, color: m.color }));
}

/** "Start section here": from `sec` to the next boundary (or 10 s on), within the song. */
export function sectionRangeFrom(markers: readonly Marker[], sec: number, duration: number): Range {
  const next = nextBoundary(boundaries(markers), sec);
  return clampRange({ start: sec, end: next ?? sec + 10 }, duration);
}

/** The update for an item dragged to `r`; the anchor only when it changes. */
export function markerPatch(
  m: Marker,
  r: Range,
  anchor: MarkerAnchor,
): { startSec: number; endSec?: number; anchor?: MarkerAnchor } {
  return {
    ...(m.type === "section" ? { startSec: r.start, endSec: r.end } : { startSec: r.start }),
    ...(anchor !== m.anchor && { anchor }),
  };
}

export type MarkerFormResult =
  | { ok: false; error: "validation.required" | "markers.badTimes" }
  | { ok: true; name: string; startSec: number; endSec: number | null };

/**
 * Checks the marker editor's fields: a name, a parseable start and, for a section, an end after
 * it. Errors are i18n keys.
 */
export function validateMarkerForm(
  type: Marker["type"],
  form: { name: string; start: string; end: string },
): MarkerFormResult {
  const startSec = parseClock(form.start);
  const endSec = type === "section" ? parseClock(form.end) : null;
  const name = form.name.trim();
  if (!name) return { ok: false, error: "validation.required" };
  if (startSec === null || (type === "section" && (endSec === null || endSec <= startSec)))
    return { ok: false, error: "markers.badTimes" };
  return { ok: true, name, startSec, endSec };
}

/**
 * Lane heights: touch devices get 44 px section lanes (SPEC §11.1 touch targets). Only lanes with
 * items take space (SPEC §11.3): no sections, no section lane; no markers, a 0 px markers lane.
 */
export function layoutFor(markers: readonly Marker[], coarse: boolean) {
  const sectionH = coarse ? 44 : 30;
  const markerH = markers.some((m) => m.type !== "section") ? (coarse ? 36 : 24) : 0;
  const sectionLanes = Math.max(
    0,
    ...markers.filter((m) => m.type === "section").map((m) => m.lane + 1),
  );
  return { sectionH, markerH, sectionLanes, height: sectionLanes * sectionH + markerH, coarse };
}

/** Dragging a timeline item: its body moves it, a section's edges resize it. */
export type DragMode = "move" | "start" | "end";

/** Which part of an item the pointer at `x` grabs: edges up to 12 px (a quarter of narrow ones). */
export function edgeModeAt(
  section: boolean,
  x: number,
  rect: { left: number; right: number; width: number },
): DragMode {
  if (!section) return "move";
  const edge = Math.min(12, rect.width / 4);
  if (x - rect.left < edge) return "start";
  if (rect.right - x < edge) return "end";
  return "move";
}

/**
 * The range of an item dragged by `dSec` from `orig`, within the song. A moved section snaps by
 * its start, else by its end; resizing keeps at least the minimum selection length.
 */
export function dragRange(
  mode: DragMode,
  orig: Range,
  dSec: number,
  duration: number,
  section: boolean,
  snap: (sec: number) => number,
): Range {
  const len = orig.end - orig.start;
  if (mode === "move") {
    let start = Math.max(0, Math.min(duration - len, orig.start + dSec));
    const s = snap(start);
    if (s !== start) start = s;
    else if (section) start = snap(start + len) - len;
    start = Math.max(0, Math.min(duration - len, start));
    return { start, end: start + len };
  }
  if (mode === "start") {
    const start = snap(Math.max(0, orig.start + dSec));
    return { start: Math.min(start, orig.end - MIN_SELECTION_SEC), end: orig.end };
  }
  const end = snap(Math.min(duration, orig.end + dSec));
  return { start: orig.start, end: Math.max(end, orig.start + MIN_SELECTION_SEC) };
}
