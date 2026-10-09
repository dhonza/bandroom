import {
  clipEnd,
  EDIT_SAMPLE_RATE,
  songEndFrame,
  uuidv7,
  type EditClip,
  type EditOp,
  type EditOptions,
  type EditState,
  type FrameRange,
} from "@bandroom/shared";
import type { View } from "../timeline/view";

/**
 * Pure logic of edit mode (SPEC §24.6): building ops from the UI state, why an action is not
 * available, clip geometry on the lanes, drags turned into moves and trims, out-of-sync tracks and
 * the edit shortcuts. The reducers themselves are the shared model (`@bandroom/shared` edit).
 */

export const secToFrames = (sec: number): number => Math.max(0, Math.round(sec * EDIT_SAMPLE_RATE));
export const framesToSec = (frames: number): number => frames / EDIT_SAMPLE_RATE;

/** What the toolbar actions act on. */
export interface EditTarget {
  state: EditState;
  /** Tracks the ops act on (track selection), in base order. */
  tracks: readonly string[];
  /** The loop selection (seconds), the edit range (SPEC §24.1). */
  selection: { start: number; end: number } | null;
  playheadSec: number;
  options: EditOptions;
  userId: string;
}

/** Why an action cannot run now (the toolbar says it, SPEC §24.6). */
export type UnavailableReason = "noRange" | "noTracks" | "noPick" | "outsideSong";

type Common = Pick<EditOp, "id" | "at" | "userId" | "timeline">;

function common(t: Pick<EditTarget, "options" | "userId">): Common {
  return { id: uuidv7(), at: Date.now(), userId: t.userId, timeline: { ...t.options.timeline } };
}

/** The edit range in frames, clamped to the song; null without a usable selection. */
export function rangeFrames(t: Pick<EditTarget, "selection" | "state">): FrameRange | null {
  const s = t.selection;
  if (!s) return null;
  const end = songEndFrame(t.state);
  const start = Math.min(secToFrames(s.start), end);
  const stop = Math.min(secToFrames(s.end), end);
  return stop > start ? { start, end: stop } : null;
}

/** Split positions: the selection's edges inside the song, else the playhead. */
export function splitFrames(t: Pick<EditTarget, "selection" | "playheadSec" | "state">): number[] {
  const end = songEndFrame(t.state);
  const inside = (f: number) => f > 0 && f < end;
  if (t.selection) {
    const edges = [secToFrames(t.selection.start), secToFrames(t.selection.end)].filter(inside);
    return [...new Set(edges)];
  }
  const at = secToFrames(t.playheadSec);
  return inside(at) ? [at] : [];
}

export type RangeAction = "cut" | "silence" | "gain";

/** Why a toolbar action is unavailable, or null. */
export function unavailable(
  action: "split" | RangeAction | "splitAtMarkers",
  t: Pick<EditTarget, "selection" | "playheadSec" | "state" | "tracks">,
): UnavailableReason | null {
  if (t.tracks.length === 0) return "noTracks";
  if (action === "splitAtMarkers") return null;
  if (action === "split") return splitFrames(t).length > 0 ? null : "outsideSong";
  return rangeFrames(t) ? null : "noRange";
}

export function splitOp(t: EditTarget): EditOp | null {
  const frames = splitFrames(t);
  if (frames.length === 0 || t.tracks.length === 0) return null;
  return { type: "split", frames, tracks: [...t.tracks], ...common(t) };
}

export function splitAtMarkersOp(
  t: EditTarget,
  points: readonly { id: string; sec: number }[],
): EditOp | null {
  const end = songEndFrame(t.state);
  const chosen = points
    .map((p) => ({ id: p.id, frame: secToFrames(p.sec) }))
    .filter((p) => p.frame > 0 && p.frame < end);
  if (chosen.length === 0 || t.tracks.length === 0) return null;
  const frames = [...new Set(chosen.map((p) => p.frame))].sort((a, b) => a - b).slice(0, 1000);
  const markerIds = [...new Set(chosen.map((p) => p.id))].slice(0, 500);
  return { type: "splitAtMarkers", markerIds, frames, tracks: [...t.tracks], ...common(t) };
}

export function rangeOp(t: EditTarget, action: RangeAction, gainDb = 0): EditOp | null {
  const range = rangeFrames(t);
  if (!range || t.tracks.length === 0) return null;
  const base = { range, tracks: [...t.tracks], fades: { ...t.options.fades }, ...common(t) };
  if (action === "gain")
    return { type: "gain", gainDb: Math.min(24, Math.max(-60, gainDb)), ...base };
  return { type: action, ...base };
}

export function moveOp(
  t: Pick<EditTarget, "options" | "userId">,
  clipIds: readonly string[],
  deltaFrames: number,
  toTrackId: string | null,
): EditOp {
  return {
    type: "move",
    clipIds: [...clipIds],
    deltaFrames,
    toTrackId,
    overlap: t.options.overlap,
    fades: { ...t.options.fades },
    ...common(t),
  };
}

export function trimOp(
  t: Pick<EditTarget, "options" | "userId">,
  clipId: string,
  edge: "start" | "end",
  deltaFrames: number,
): EditOp {
  return {
    type: "trim",
    clipId,
    edge,
    deltaFrames,
    overlap: t.options.overlap,
    fades: { ...t.options.fades },
    ...common(t),
  };
}

// ——— split at markers/sections ————————————————————————————————————————————————————————

export interface SplitPoint {
  /** `<marker id>` or `<section id>:start|end`. */
  key: string;
  markerId: string;
  name: string;
  sec: number;
  kind: "marker" | "sectionStart" | "sectionEnd";
}

/** The markers and section edges offered by "Split at markers/sections" (SPEC §24.3). */
export function splitPoints(
  markers: readonly { id: string; name: string; startSec: number; endSec: number | null }[],
  durationSec: number,
): SplitPoint[] {
  const out: SplitPoint[] = [];
  for (const m of markers) {
    if (m.endSec === null) {
      out.push({ key: m.id, markerId: m.id, name: m.name, sec: m.startSec, kind: "marker" });
      continue;
    }
    out.push({
      key: `${m.id}:start`,
      markerId: m.id,
      name: m.name,
      sec: m.startSec,
      kind: "sectionStart",
    });
    out.push({
      key: `${m.id}:end`,
      markerId: m.id,
      name: m.name,
      sec: m.endSec,
      kind: "sectionEnd",
    });
  }
  return out
    .filter((p) => p.sec > 0 && p.sec < durationSec)
    .sort((a, b) => a.sec - b.sec || a.key.localeCompare(b.key));
}

// ——— clip geometry —————————————————————————————————————————————————————————————————————

/** Where a clip is drawn in the detail view (x relative to the view, y to its lane). */
export interface ClipBox {
  clip: EditClip;
  trackIndex: number;
  /** Unclamped edges in px (may lie far outside the view). */
  x0: number;
  x1: number;
  /** The drawn part, clamped to the view plus a margin (DOM widths stay small at deep zoom). */
  left: number;
  width: number;
  startVisible: boolean;
  endVisible: boolean;
}

/** Margin beyond the view where clips are still laid out (edge handles reach into it). */
export const CLIP_MARGIN_PX = 48;

/** The clips visible in the view, per lane (SPEC §24.6). */
export function clipBoxes(
  view: Pick<View, "startSec" | "pxPerSec" | "widthPx">,
  tracks: readonly { clips: readonly EditClip[] }[],
): ClipBox[] {
  const out: ClipBox[] = [];
  const lo = -CLIP_MARGIN_PX;
  const hi = view.widthPx + CLIP_MARGIN_PX;
  tracks.forEach((t, trackIndex) => {
    for (const clip of t.clips) {
      const x0 = (framesToSec(clip.startFrame) - view.startSec) * view.pxPerSec;
      const x1 = (framesToSec(clipEnd(clip)) - view.startSec) * view.pxPerSec;
      if (x1 < lo || x0 > hi) continue;
      const left = Math.max(lo, x0);
      const right = Math.min(hi, x1);
      out.push({
        clip,
        trackIndex,
        x0,
        x1,
        left,
        width: Math.max(1, right - left),
        startVisible: x0 >= lo,
        endVisible: x1 <= hi,
      });
    }
  });
  return out;
}

/** Edge handles of picked clips: 44 px wide touch targets centred on the edge (SPEC §11.1). */
export const HANDLE_PX = 44;

/**
 * An SVG path of a fade over `w` × `h` px: rising (`in`) or falling (`out`), `linear` or
 * `equalPower` (sin/cos, as the engine plays it, M16).
 */
export function fadePath(w: number, h: number, shape: "linear" | "equalPower", dir: "in" | "out") {
  const steps = shape === "linear" ? 1 : 16;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const g = shape === "linear" ? k : Math.sin((k * Math.PI) / 2);
    const gain = dir === "in" ? g : shape === "linear" ? 1 - k : Math.cos((k * Math.PI) / 2);
    pts.push(`${(k * w).toFixed(1)},${((1 - gain) * h).toFixed(1)}`);
  }
  return `M${pts.join("L")}`;
}

// ——— drags ————————————————————————————————————————————————————————————————————————————

/** Snaps a time (seconds); returns the same value when nothing is near. */
export type Snap = (sec: number) => number;

/** Edges (seconds) of every clip except the moved ones: snap targets of a drag (SPEC §24.3). */
export function clipEdges(state: EditState, except: ReadonlySet<string>): number[] {
  const set = new Set<number>();
  for (const t of state.tracks)
    for (const c of t.clips) {
      if (except.has(c.id)) continue;
      set.add(c.startFrame);
      set.add(clipEnd(c));
    }
  return [...set].sort((a, b) => a - b).map(framesToSec);
}

export interface MoveDrag {
  /** The picked clips being moved (all of them when the grabbed one is picked). */
  clipIds: readonly string[];
  /** The clip under the pointer: its start (else end) snaps. */
  grabbed: EditClip;
  /** Its lane and the pointer's y within it at the start. */
  fromTrack: number;
  grabY: number;
}

export interface MoveResult {
  deltaFrames: number;
  /** Target lane index for a vertical move; null keeps every clip on its track. */
  toTrack: number | null;
  /** The snapped time (seconds), for the snap line; null when nothing snapped. */
  snappedSec: number | null;
}

/**
 * A body drag as a move (SPEC §24.6): the time delta from `dx` with the grabbed clip's start
 * snapped (else its end), never before 0; a vertical drag past a lane edge targets that lane
 * when all moved clips are on one track.
 */
export function moveFromDrag(
  d: MoveDrag,
  state: EditState,
  dx: number,
  dy: number,
  view: Pick<View, "pxPerSec">,
  laneHeight: number,
  snap: Snap | null,
): MoveResult {
  const moved = new Set(d.clipIds);
  let minStart = Infinity;
  const tracksOf = new Set<number>();
  state.tracks.forEach((t, i) => {
    for (const c of t.clips)
      if (moved.has(c.id)) {
        minStart = Math.min(minStart, c.startFrame);
        tracksOf.add(i);
      }
  });
  if (!Number.isFinite(minStart)) minStart = d.grabbed.startFrame;
  const raw = dx / view.pxPerSec;
  const start = framesToSec(d.grabbed.startFrame);
  const end = framesToSec(clipEnd(d.grabbed));
  let delta = raw;
  let snappedSec: number | null = null;
  if (snap) {
    const s = snap(start + raw);
    if (s !== start + raw) {
      delta = s - start;
      snappedSec = s;
    } else {
      const e = snap(end + raw);
      if (e !== end + raw) {
        delta = e - end;
        snappedSec = e;
      }
    }
  }
  const deltaFrames = Math.max(-minStart, Math.round(delta * EDIT_SAMPLE_RATE)) || 0;
  if (deltaFrames !== Math.round(delta * EDIT_SAMPLE_RATE)) snappedSec = null;
  const laneShift = Math.floor((d.grabY + dy) / Math.max(1, laneHeight));
  const target = Math.min(state.tracks.length - 1, Math.max(0, d.fromTrack + laneShift));
  const toTrack = tracksOf.size <= 1 && target !== d.fromTrack ? target : null;
  return { deltaFrames, toTrack, snappedSec };
}

export interface TrimResult {
  deltaFrames: number;
  snappedSec: number | null;
}

/** An edge-handle drag as a trim delta (snapped; the clip keeps at least 1 frame). */
export function trimFromDrag(
  clip: EditClip,
  edge: "start" | "end",
  dx: number,
  view: Pick<View, "pxPerSec">,
  snap: Snap | null,
): TrimResult {
  const at = framesToSec(edge === "start" ? clip.startFrame : clipEnd(clip));
  const raw = at + dx / view.pxPerSec;
  const snapped = snap ? snap(raw) : raw;
  const target = Math.max(0, snapped);
  let deltaFrames = Math.round((target - at) * EDIT_SAMPLE_RATE);
  if (edge === "start") deltaFrames = Math.min(deltaFrames, clip.lengthFrames - 1);
  else deltaFrames = Math.max(deltaFrames, 1 - clip.lengthFrames);
  return { deltaFrames, snappedSec: snapped !== raw ? snapped : null };
}

// ——— out of sync ————————————————————————————————————————————————————————————————————————

/**
 * Tracks shifted by cuts on a subset of tracks (SPEC §24.3): per track, how many other tracks
 * it is out of sync with. Tracks in the largest group of equal shifts (ties: the least shifted)
 * are in sync; the others are listed.
 */
export function outOfSync(
  ops: readonly EditOp[],
  cursor: number,
  trackIds: readonly string[],
): Record<string, number> {
  const shift = new Map(trackIds.map((id) => [id, 0]));
  for (const op of ops.slice(0, cursor)) {
    if (op.type !== "cut") continue;
    const len = op.range.end - op.range.start;
    for (const id of op.tracks) if (shift.has(id)) shift.set(id, (shift.get(id) ?? 0) + len);
  }
  const groups = new Map<number, number>();
  for (const s of shift.values()) groups.set(s, (groups.get(s) ?? 0) + 1);
  if (groups.size <= 1) return {};
  let ref = 0;
  let best = -1;
  for (const [s, n] of [...groups].sort((a, b) => a[0] - b[0]))
    if (n > best) {
      best = n;
      ref = s;
    }
  const out: Record<string, number> = {};
  for (const [id, s] of shift) if (s !== ref) out[id] = trackIds.length - (groups.get(s) ?? 0);
  return out;
}

// ——— shortcuts ——————————————————————————————————————————————————————————————————————————

export type EditKeyAction = "split" | "cut" | "silence" | "gain" | "undo" | "redo" | "escape";

interface KeyLike {
  key: string;
  code: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * Edit mode keys (SPEC §24.6): `X` split (`S` stays the snap cycle), `Delete`/`Backspace` cut,
 * `Shift+Delete` silence, `G` gain, `Cmd/Ctrl+Z` undo, `Cmd/Ctrl+Shift+Z` and `Ctrl+Y` redo,
 * `Esc` (the pick first, then the song page's selection).
 */
export function resolveEditKey(e: KeyLike): EditKeyAction | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.ctrlKey || e.metaKey) {
    if (e.altKey) return null;
    if (key === "z") return e.shiftKey ? "redo" : "undo";
    if (key === "y" && e.ctrlKey && !e.shiftKey) return "redo";
    return null;
  }
  if (e.altKey) return null;
  if (key === "Delete" || key === "Backspace") return e.shiftKey ? "silence" : "cut";
  if (e.shiftKey) return null;
  if (key === "x") return "split";
  if (key === "g") return "gain";
  if (key === "Escape") return "escape";
  return null;
}
