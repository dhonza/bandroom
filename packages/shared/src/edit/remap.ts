import type { CommentContext } from "../comments";
import type { Marker } from "../markers";
import { barAtBeat, bpmAtBeat, compileTempo, secToBeat, type TempoGrid } from "../tempo/math";
import {
  barQuarters,
  BEAT_EPS,
  normalizeSegments,
  type Tempo,
  type TempoSegmentInput,
} from "../tempo/model";
import { clipEnd } from "./clips";
import { applyOp, initialState, type EditState } from "./ops";
import { EDIT_SAMPLE_RATE, type EditBase, type EditOp, type RemapStep } from "./schema";
import {
  cutTimeMap,
  mapTime,
  mapTimeRange,
  moveTimeMap,
  scaleTimeMap,
  type TimeMap,
} from "./timeMap";

/**
 * The timeline follow-up of an edit (SPEC §24.4): which ops move the shared timeline, and how
 * markers, sections, comments and the tempo map follow. Pure; the client previews it, the server
 * writes it when an edit is applied.
 */

// ——— which ops remap ———————————————————————————————————————————————————————————————————

/**
 * The timeline change of one op, or null. Only ops on all tracks that change time count: a cut,
 * or a move by one delta, within their tracks, of every clip touching one range on every track.
 */
export function timelineStep(before: EditState, after: EditState, op: EditOp): RemapStep | null {
  const all = before.tracks.map((t) => t.trackId);
  if (op.type === "cut") {
    const chosen = new Set(op.tracks);
    if (!all.every((t) => chosen.has(t))) return null;
    return { kind: "cut", start: op.range.start, end: op.range.end, timeline: op.timeline };
  }
  if (op.type !== "move") return null;
  const ids = new Set(op.clipIds);
  const start = new Map<string, { start: number; track: number }>();
  let lo = Infinity;
  let hi = -Infinity;
  before.tracks.forEach((t, i) => {
    for (const c of t.clips)
      if (ids.has(c.id)) {
        start.set(c.id, { start: c.startFrame, track: i });
        lo = Math.min(lo, c.startFrame);
        hi = Math.max(hi, clipEnd(c));
      }
  });
  const deltas = new Set<number>();
  after.tracks.forEach((t, i) => {
    for (const c of t.clips) {
      const was = start.get(c.id);
      if (was) deltas.add(was.track === i ? c.startFrame - was.start : NaN);
    }
  });
  const [delta] = [...deltas];
  if (deltas.size !== 1 || !delta) return null;
  const covers = before.tracks.every(
    (t) =>
      t.clips.some((c) => ids.has(c.id)) &&
      t.clips.every((c) => ids.has(c.id) || clipEnd(c) <= lo || c.startFrame >= hi),
  );
  return covers ? { kind: "move", start: lo, end: hi, delta, timeline: op.timeline } : null;
}

/** The timeline steps of a session: the folded ones, then those of the first `cursor` ops. */
export function remapSteps(
  base: EditBase,
  ops: readonly EditOp[],
  cursor = ops.length,
): RemapStep[] {
  const steps = [...base.remap];
  let state = initialState(base);
  for (const op of ops.slice(0, cursor)) {
    const next = applyOp(state, op);
    const step = timelineStep(state, next, op);
    if (step) steps.push(step);
    state = next;
  }
  return steps;
}

/** A step's map in seconds (frames at 48 kHz). */
export function stepTimeMap(step: RemapStep): TimeMap {
  const map =
    step.kind === "cut"
      ? cutTimeMap(step.start, step.end)
      : moveTimeMap(step.start, step.end, step.delta);
  return scaleTimeMap(map, 1 / EDIT_SAMPLE_RATE);
}

// ——— tempo ——————————————————————————————————————————————————————————————————————————————

/**
 * The tempo map after `[s, e)` (seconds) is cut out. Bar 1 moves left when the cut lies before
 * it. Segments after the cut move with the audio; those inside are dropped. At the join a segment
 * continues with the tempo and meter of the audio after the cut; when the join is off a bar line,
 * a new bar starts there and another at the next downbeat of that audio (`newBar`), so later
 * bars stay on their beats and the bar index continues. Ramps are split exactly.
 */
export function cutTempo(tempo: Tempo, s: number, e: number): Tempo {
  const o = tempo.bar1OffsetSec;
  if (e <= o) return { map: tempo.map, bar1OffsetSec: o - (e - s) };
  const g = compileTempo(tempo);
  const join = s <= o ? 0 : secToBeat(g, s);
  const be = secToBeat(g, e);
  const removed = be - join;
  const segs = tempo.map.segments;
  const out: TempoSegmentInput[] = [];
  segs.forEach((x, i) => {
    if (x.startBeat >= join - BEAT_EPS) return;
    const next = segs[i + 1];
    const ramps = x.bpmEnd !== undefined && next && next.startBeat > join + BEAT_EPS;
    out.push(ramps ? { ...x, bpmEnd: bpmAtBeat(g, join) } : { ...x });
  });
  const ci = segs.findLastIndex((x) => x.startBeat <= be + BEAT_EPS);
  const c = segs[ci] as TempoSegmentInput;
  const bar = barAtBeat(g, be);
  const joinSeg: TempoSegmentInput = { startBeat: join, bpm: bpmAtBeat(g, be), meter: bar.meter };
  if (c.bpmEnd !== undefined && segs[ci + 1]) joinSeg.bpmEnd = c.bpmEnd;
  const barQ = barQuarters(bar.meter);
  const offBar = be - bar.startBeat >= BEAT_EPS;
  if (join > 0 && (offBar || !onBarLine(g, join))) joinSeg.newBar = true;
  out.push(joinSeg);
  for (const x of segs)
    if (x.startBeat > be + BEAT_EPS) out.push({ ...x, startBeat: x.startBeat - removed });
  if (offBar) {
    const region = g.regions.find((r) => r.startBeat > be + BEAT_EPS)?.startBeat ?? Infinity;
    const down = Math.min(bar.startBeat + barQ, region);
    const at = down - removed;
    const same = out.findIndex((x) => Math.abs(x.startBeat - at) < BEAT_EPS);
    if (same >= 0) out[same] = { ...(out[same] as TempoSegmentInput), newBar: true };
    else {
      const pi = out.findLastIndex((x) => x.startBeat < at);
      const p = out[pi] as TempoSegmentInput;
      const seg: TempoSegmentInput = {
        startBeat: at,
        bpm: bpmAtBeat(g, down),
        meter: bar.meter,
        newBar: true,
      };
      if (p.bpmEnd !== undefined) {
        seg.bpmEnd = p.bpmEnd;
        out[pi] = { ...p, bpmEnd: bpmAtBeat(g, down) };
      }
      out.splice(pi + 1, 0, seg);
    }
  }
  const r = normalizeSegments(out);
  return r.ok ? { map: { segments: r.segments }, bar1OffsetSec: Math.min(s, o) } : tempo;
}

function onBarLine(g: TempoGrid, beat: number): boolean {
  return beat - barAtBeat(g, beat).startBeat < BEAT_EPS;
}

/** The tempo after one step (moves leave it: two pieces of music cannot share one map). */
function stepTempo(tempo: Tempo, step: RemapStep): Tempo {
  if (step.kind !== "cut") return tempo;
  return cutTempo(tempo, step.start / EDIT_SAMPLE_RATE, step.end / EDIT_SAMPLE_RATE);
}

/** The tempo map (with bar 1) after the steps whose tempo switch is on. */
export function remapTempoMap(tempo: Tempo | null, steps: readonly RemapStep[]): Tempo | null {
  let t = tempo;
  for (const s of steps) if (t && s.timeline.tempo) t = stepTempo(t, s);
  return t;
}

// ——— markers and sections ————————————————————————————————————————————————————————————

export type RemappableMarker = Pick<
  Marker,
  "id" | "type" | "startSec" | "endSec" | "anchor" | "startBeat" | "endBeat"
>;

/** Beats are stored rounded to 1e-9 quarter notes (as the server does). */
const roundBeat = (b: number) => Math.round(b * 1e9) / 1e9;

export interface MarkerRemap<T> {
  /** The surviving items, mapped. */
  items: T[];
  deleted: string[];
  /** Surviving items whose times changed. */
  moved: string[];
}

/**
 * Markers and sections after the steps (SPEC §24.4): markers are mapped (deleted inside a cut),
 * sections shrink (deleted when nothing of them is left). Musical items stay on the music: their
 * beats are recomputed on the tempo map after each step (with the tempo following, the same beats
 * of the audio; otherwise where the item now sits).
 */
export function remapMarkers<T extends RemappableMarker>(
  items: readonly T[],
  steps: readonly RemapStep[],
  tempo: Tempo | null,
): MarkerRemap<T> {
  let live = [...items];
  const deleted: string[] = [];
  let t = tempo;
  for (const step of steps) {
    const before = t;
    if (t && step.timeline.tempo) t = stepTempo(t, step);
    const grid = t ? compileTempo(t) : null;
    const map = stepTimeMap(step);
    const next: T[] = [];
    for (const m of live) {
      const follows = m.type === "marker" ? step.timeline.markers : step.timeline.sections;
      let x = m;
      if (follows) {
        if (m.endSec === null) {
          const at = mapTime(map, m.startSec);
          if (at === null) {
            deleted.push(m.id);
            continue;
          }
          x = { ...m, startSec: at };
        } else {
          const r = mapTimeRange(map, m.startSec, m.endSec);
          if (!r) {
            deleted.push(m.id);
            continue;
          }
          x = { ...m, startSec: r.start, endSec: r.end };
        }
      }
      if (grid && x.anchor === "musical" && (follows || t !== before))
        x = {
          ...x,
          startBeat: roundBeat(secToBeat(grid, x.startSec)),
          endBeat: x.endSec === null ? null : roundBeat(secToBeat(grid, x.endSec)),
        };
      next.push(x);
    }
    live = next;
  }
  const was = new Map(items.map((m) => [m.id, m]));
  const moved = live
    .filter((m) => {
      const w = was.get(m.id) as T;
      return w.startSec !== m.startSec || w.endSec !== m.endSec;
    })
    .map((m) => m.id);
  return { items: live, deleted, moved };
}

// ——— comments ————————————————————————————————————————————————————————————————————————————

export interface RemappableComment {
  id: string;
  /** Null = general comment (replies too). */
  startSec: number | null;
  endSec: number | null;
  context: CommentContext;
}

export interface CommentRemap<T> {
  /** Every comment, mapped; edited-out ones are general now. */
  items: T[];
  editedOut: string[];
  moved: string[];
}

/**
 * Comments after the steps (SPEC §24.4): times map like markers and sections; a comment whose
 * time was cut away becomes general and keeps its old time in `context.editedOut`.
 */
export function remapComments<T extends RemappableComment>(
  items: readonly T[],
  steps: readonly RemapStep[],
  sessionId: string,
): CommentRemap<T> {
  const editedOut: string[] = [];
  const moved: string[] = [];
  const out = items.map((orig) => {
    let c = orig;
    for (const step of steps) {
      if (!step.timeline.comments || c.startSec === null) continue;
      const map = stepTimeMap(step);
      const r =
        c.endSec === null
          ? ((at) => (at === null ? null : { start: at, end: null }))(mapTime(map, c.startSec))
          : mapTimeRange(map, c.startSec, c.endSec);
      c = r
        ? { ...c, startSec: r.start, endSec: r.end }
        : {
            ...c,
            startSec: null,
            endSec: null,
            context: {
              ...c.context,
              editedOut: { startSec: orig.startSec as number, endSec: orig.endSec, sessionId },
            },
          };
    }
    if (orig.startSec !== null && c.startSec === null) editedOut.push(c.id);
    else if (orig.startSec !== c.startSec || orig.endSec !== c.endSec) moved.push(c.id);
    return c;
  });
  return { items: out, editedOut, moved };
}
