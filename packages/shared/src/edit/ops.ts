import {
  canonicalClips,
  clampFades,
  clipEnd,
  contiguous,
  extendEnd,
  extendStart,
  headOf,
  idMaker,
  maxOverlap,
  sortClips,
  sourceAfter,
  sourceBefore,
  tailOf,
  withFadeIn,
  withFadeOut,
} from "./clips";
import {
  MAX_CLIPS_PER_TRACK,
  MAX_EDIT_OPS,
  MAX_OVERLAPPING_CLIPS,
  type EditBase,
  type EditClip,
  type EditFades,
  type EditOp,
  type OverlapMode,
} from "./schema";

/**
 * Pure, deterministic edit reducers (SPEC §24.3). State = `replay(base, ops, cursor)`; undo and
 * redo only move the cursor, and a reload, a second device or a takeover rebuild the same clips.
 */

export interface TrackClips {
  trackId: string;
  /** In timeline order. */
  clips: EditClip[];
}

export interface EditState {
  /** In base order. */
  tracks: TrackClips[];
  /** Version lengths (48 kHz frames) by version id: how far a clip can reveal its source. */
  sources: Readonly<Record<string, number>>;
  /** Ops replayed on the base (folded ones not counted). */
  ops: number;
}

type Op<T extends EditOp["type"]> = Extract<EditOp, { type: T }>;
type Lengths = EditState["sources"];

/** The state before any op. */
export function initialState(base: EditBase): EditState {
  return {
    tracks: base.tracks.map((t) => ({
      trackId: t.trackId,
      clips: sortClips([...(t.folded ?? (t.clip ? [t.clip] : []))]),
    })),
    sources: Object.fromEntries(base.tracks.map((t) => [t.versionId, t.lengthFrames])),
    ops: 0,
  };
}

/** The end of the last clip of any track. */
export function songEndFrame(state: EditState): number {
  let end = 0;
  for (const t of state.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

// ——— shared pieces ————————————————————————————————————————————————————————————————————

interface Removed {
  /** Clips the range does not touch. */
  rest: EditClip[];
  /** Pieces cut at the range start (now ending there). */
  heads: EditClip[];
  /** Pieces cut at the range end (now starting there). */
  tails: EditClip[];
  /** Untouched clips ending exactly at the range start / starting exactly at its end. */
  touchHeads: EditClip[];
  touchTails: EditClip[];
  /** Whether any audio lay inside the range. */
  hit: boolean;
}

/** Removes `[s, e)` from the clips. A clip split in two gets two new ids; a trimmed one keeps its. */
function removeRange(clips: readonly EditClip[], s: number, e: number, id: () => string): Removed {
  const r: Removed = { rest: [], heads: [], tails: [], touchHeads: [], touchTails: [], hit: false };
  for (const c of clips) {
    const end = clipEnd(c);
    if (end <= s || c.startFrame >= e) {
      if (end === s) r.touchHeads.push(c);
      else if (c.startFrame === e) r.touchTails.push(c);
      else r.rest.push(c);
      continue;
    }
    r.hit = true;
    const head = c.startFrame < s;
    const tail = end > e;
    if (head && tail) {
      r.heads.push(headOf(c, s, id()));
      r.tails.push(tailOf(c, e, id()));
    } else if (head) r.heads.push(headOf(c, s, c.id));
    else if (tail) r.tails.push(tailOf(c, e, c.id));
  }
  return r;
}

const shift = (c: EditClip, by: number): EditClip => ({ ...c, startFrame: c.startFrame + by });

/**
 * Crossfades unrelated audio at a join (cut, SPEC §24.3): each side reaches half the crossfade
 * into the audio its source has beyond the join; a side without such audio leaves the fade
 * one-sided. With no audio on either side both fade within themselves (a short dip).
 */
function crossfadeJoin(
  heads: EditClip[],
  tails: EditClip[],
  cf: number,
  lengths: Lengths,
): { heads: EditClip[]; tails: EditClip[] } {
  if (cf === 0) return { heads, tails };
  const half = Math.floor(cf / 2);
  const hs = heads.map((c) => ({ c, ext: Math.min(half, sourceAfter(c, lengths)) }));
  const ts = tails.map((c) => ({ c, ext: Math.min(cf - half, sourceBefore(c)) }));
  const maxH = Math.max(...hs.map((x) => x.ext));
  const maxT = Math.max(...ts.map((x) => x.ext));
  return {
    heads: hs.map(({ c, ext }) => withFadeOut(extendEnd(c, ext), ext + maxT || half, "equalPower")),
    tails: ts.map(({ c, ext }) =>
      withFadeIn(extendStart(c, ext), ext + maxH || cf - half, "equalPower"),
    ),
  };
}

/** A linear crossfade between two contiguous pieces of one source: an exact gain ramp. */
function rampJoin(a: EditClip, b: EditClip, cf: number, lengths: Lengths): [EditClip, EditClip] {
  const half = Math.floor(cf / 2);
  const extA = Math.min(half, sourceAfter(a, lengths));
  const extB = Math.min(cf - half, sourceBefore(b));
  const fade = extA + extB;
  return [
    withFadeOut(extendEnd(a, extA), fade, "linear"),
    withFadeIn(extendStart(b, extB), fade, "linear"),
  ];
}

/** Splits every clip covering one of the points (strictly inside it) into contiguous halves. */
function splitAt(clips: readonly EditClip[], points: readonly number[], id: () => string) {
  const sorted = [...new Set(points)].sort((a, b) => a - b);
  const out: EditClip[] = [];
  for (const c of clips) {
    let cur = c;
    for (const p of sorted) {
      if (p <= cur.startFrame || p >= clipEnd(cur)) continue;
      out.push(headOf(cur, p, id()));
      cur = tailOf(cur, p, id());
    }
    out.push(cur);
  }
  return out;
}

const overlaps = (a: EditClip, b: EditClip) =>
  a.startFrame < clipEnd(b) && b.startFrame < clipEnd(a);

/** `mix`: both play; the edges lying inside the other clip fade over the crossfade. */
function mixEdges(
  winner: EditClip,
  others: EditClip[],
  cf: number,
  only: (o: EditClip) => boolean,
): { winner: EditClip; others: EditClip[] } {
  let w = winner;
  const out = others.map((o) => {
    if (!overlaps(w, o) || !only(o)) return o;
    const oEnd = clipEnd(o);
    const wEnd = clipEnd(w);
    if (o.startFrame < w.startFrame) w = withFadeIn(w, cf, "equalPower");
    if (oEnd > wEnd) w = withFadeOut(w, cf, "equalPower");
    let x = o;
    if (w.startFrame < o.startFrame) x = withFadeIn(x, cf, "equalPower");
    if (oEnd < wEnd) x = withFadeOut(x, cf, "equalPower");
    return x;
  });
  return { winner: w, others: out };
}

/**
 * `overwrite`: `[rs, re)` of the other clips goes away. Pieces that meet the winner's edge reach
 * up to the crossfade back under it (the covered audio is theirs) and crossfade with it; other
 * new edges fade over the crossfade.
 */
function overwriteRange(
  winner: EditClip,
  others: readonly EditClip[],
  rs: number,
  re: number,
  cf: number,
  lengths: Lengths,
  id: () => string,
): { winner: EditClip; others: EditClip[] } {
  const r = removeRange(others, rs, re, id);
  let w = winner;
  const heads = r.heads.map((h) => {
    if (rs !== w.startFrame) return withFadeOut(h, cf, "equalPower");
    const ext = Math.min(cf, sourceAfter(h, lengths));
    if (ext > 0) w = withFadeIn(w, Math.max(ext, w.fadeInFrames), "equalPower");
    return withFadeOut(extendEnd(h, ext), ext, "equalPower");
  });
  const tails = r.tails.map((t) => {
    if (re !== clipEnd(w)) return withFadeIn(t, cf, "equalPower");
    const ext = Math.min(cf, sourceBefore(t));
    if (ext > 0) w = withFadeOut(w, Math.max(ext, w.fadeOutFrames), "equalPower");
    return withFadeIn(extendStart(t, ext), ext, "equalPower");
  });
  return { winner: w, others: [...r.rest, ...r.touchHeads, ...r.touchTails, ...heads, ...tails] };
}

function mapTracks(
  state: EditState,
  trackIds: readonly string[],
  f: (clips: EditClip[]) => EditClip[],
): TrackClips[] {
  const chosen = new Set(trackIds);
  return state.tracks.map((t) => (chosen.has(t.trackId) ? { ...t, clips: f(t.clips) } : t));
}

// ——— reducers ——————————————————————————————————————————————————————————————————————————

function split(state: EditState, op: Op<"split"> | Op<"splitAtMarkers">): TrackClips[] {
  const id = idMaker(op.id);
  return mapTracks(state, op.tracks, (clips) => splitAt(clips, op.frames, id));
}

function cut(state: EditState, op: Op<"cut">): TrackClips[] {
  const { start: s, end: e } = op.range;
  const len = e - s;
  const id = idMaker(op.id);
  return mapTracks(state, op.tracks, (clips) => {
    const r = removeRange(clips, s, e, id);
    const heads = [...r.heads, ...r.touchHeads];
    const tails = [...r.tails, ...r.touchTails].map((c) => shift(c, -len));
    const rest = r.rest.map((c) => (c.startFrame >= e ? shift(c, -len) : c));
    return [...rest, ...joinEdges(heads, tails, op.fades, state.sources)];
  });
}

/** The fades at a cut's join; at the song start or end (one side empty) fade in or out. */
function joinEdges(heads: EditClip[], tails: EditClip[], f: EditFades, lengths: Lengths) {
  if (heads.length === 0) return tails.map((c) => withFadeIn(c, f.fadeIn, "equalPower"));
  if (tails.length === 0) return heads.map((c) => withFadeOut(c, f.fadeOut, "equalPower"));
  const j = crossfadeJoin(heads, tails, f.crossfade, lengths);
  return [...j.heads, ...j.tails];
}

function silence(state: EditState, op: Op<"silence">): TrackClips[] {
  const { start: s, end: e } = op.range;
  const id = idMaker(op.id);
  return mapTracks(state, op.tracks, (clips) => {
    const r = removeRange(clips, s, e, id);
    if (!r.hit) return clips;
    return [
      ...r.rest,
      ...[...r.heads, ...r.touchHeads].map((c) => withFadeOut(c, op.fades.fadeOut, "equalPower")),
      ...[...r.tails, ...r.touchTails].map((c) => withFadeIn(c, op.fades.fadeIn, "equalPower")),
    ];
  });
}

function gain(state: EditState, op: Op<"gain">): TrackClips[] {
  const { start: s, end: e } = op.range;
  const id = idMaker(op.id);
  const inside = (c: EditClip) => c.startFrame >= s && clipEnd(c) <= e;
  return mapTracks(state, op.tracks, (clips) => {
    const pieces = splitAt(clips, [s, e], id);
    const ins = new Set(pieces.filter(inside).map((c) => c.id));
    let out = pieces.map((c) => (ins.has(c.id) ? { ...c, gainDb: op.gainDb } : c));
    if (op.fades.crossfade === 0) return out;
    for (const edge of [s, e]) {
      for (const a of out.filter((c) => clipEnd(c) === edge)) {
        const b = out.find((c) => c.startFrame === edge && contiguous(a, c));
        if (!b || ins.has(a.id) === ins.has(b.id)) continue;
        const [a2, b2] = rampJoin(a, b, op.fades.crossfade, state.sources);
        out = out.map((c) => (c === a ? a2 : c === b ? b2 : c));
      }
    }
    return out;
  });
}

interface Located {
  clip: EditClip;
  track: number;
}

function locate(state: EditState, ids: readonly string[]): Located[] {
  const want = new Set(ids);
  const out: Located[] = [];
  state.tracks.forEach((t, track) => {
    for (const clip of t.clips) if (want.has(clip.id)) out.push({ clip, track });
  });
  return out;
}

/**
 * `block`: the delta (from 0 towards `delta`) at which no moved clip overlaps another clip of its
 * target track: the clips stop where they touch their neighbours. When they already overlap at 0
 * (a move to another track), the free position closest to `delta`, never before `min`.
 */
function blockDelta(
  moved: readonly { clip: EditClip; target: number }[],
  tracks: readonly EditClip[][],
  delta: number,
  min: number,
): number {
  const forbidden: [number, number][] = [];
  for (const { clip, target } of moved)
    for (const o of tracks[target] as EditClip[])
      forbidden.push([o.startFrame - clipEnd(clip), clipEnd(o) - clip.startFrame]);
  const free = (d: number) => forbidden.every(([lo, hi]) => d <= lo || d >= hi);
  if (free(0)) {
    if (delta > 0) return Math.min(delta, ...forbidden.map(([lo]) => lo).filter((lo) => lo >= 0));
    return Math.max(delta, ...forbidden.map(([, hi]) => hi).filter((hi) => hi <= 0));
  }
  // The largest end is always free, so there is a candidate.
  return [delta, ...forbidden.flat()]
    .filter((d) => d >= min && free(d))
    .reduce((best, d) => (Math.abs(d - delta) < Math.abs(best - delta) ? d : best), Infinity);
}

function move(state: EditState, op: Op<"move">): TrackClips[] {
  const found = locate(state, op.clipIds);
  if (found.length === 0) return state.tracks;
  const toIdx = state.tracks.findIndex((t) => t.trackId === op.toTrackId);
  const target = (l: Located) => (toIdx >= 0 ? toIdx : l.track);
  const ids = new Set(found.map((l) => l.clip.id));
  const remaining = state.tracks.map((t) => t.clips.filter((c) => !ids.has(c.id)));
  const min = -Math.min(...found.map((l) => l.clip.startFrame));
  const movedWithTarget = found.map((l) => ({ clip: l.clip, target: target(l) }));
  let delta = Math.max(op.deltaFrames, min);
  if (op.overlap === "block") delta = blockDelta(movedWithTarget, remaining, delta, min);
  const cf = op.fades.crossfade;
  const id = idMaker(op.id);
  const placed = remaining.map((c) => [...c]);
  const winners = sortClips(movedWithTarget.map(({ clip }) => shift(clip, delta)));
  for (const w of winners) {
    const t = movedWithTarget.find((m) => m.clip.id === w.id)?.target as number;
    const r = settle(w, placed[t] as EditClip[], op.overlap, cf, state.sources, id);
    placed[t] = [...r.others, r.winner];
  }
  return state.tracks.map((t, i) => ({ ...t, clips: placed[i] as EditClip[] }));
}

/** Overlaps of a moved clip with the clips of its new track, per the overlap mode. */
function settle(
  w: EditClip,
  others: EditClip[],
  mode: OverlapMode,
  cf: number,
  lengths: Lengths,
  id: () => string,
  region: [number, number] = [w.startFrame, clipEnd(w)],
): { winner: EditClip; others: EditClip[] } {
  const [rs, re] = region;
  if (mode === "overwrite") return overwriteRange(w, others, rs, re, cf, lengths, id);
  if (mode === "mix") return mixEdges(w, others, cf, (o) => o.startFrame < re && rs < clipEnd(o));
  return { winner: w, others };
}

function trim(state: EditState, op: Op<"trim">): TrackClips[] {
  const [hit] = locate(state, [op.clipId]);
  if (!hit) return state.tracks;
  const c = hit.clip;
  const others = (state.tracks[hit.track] as TrackClips).clips.filter((x) => x.id !== c.id);
  const end = clipEnd(c);
  let next: EditClip;
  let region: [number, number] | null = null;
  if (op.edge === "start") {
    let start = Math.min(
      end - 1,
      Math.max(c.startFrame - sourceBefore(c), c.startFrame + op.deltaFrames),
    );
    if (op.overlap === "block" && start < c.startFrame)
      for (const o of others)
        if (o.startFrame < c.startFrame)
          start = Math.max(start, Math.min(clipEnd(o), c.startFrame));
    next = extendStart(c, c.startFrame - start);
    if (start < c.startFrame) region = [start, c.startFrame];
  } else {
    const max = end + sourceAfter(c, state.sources);
    let newEnd = Math.max(c.startFrame + 1, Math.min(max, end + op.deltaFrames));
    if (op.overlap === "block" && newEnd > end)
      for (const o of others)
        if (clipEnd(o) > end) newEnd = Math.min(newEnd, Math.max(o.startFrame, end));
    next = extendEnd(c, newEnd - end);
    if (newEnd > end) region = [end, newEnd];
  }
  const r = region
    ? settle(next, others, op.overlap, op.fades.crossfade, state.sources, idMaker(op.id), region)
    : { winner: next, others };
  return state.tracks.map((t, i) =>
    i === hit.track ? { ...t, clips: [...r.others, r.winner] } : t,
  );
}

/** Applies one op (pure). Unknown tracks or clips are ignored, so a replay never fails. */
export function applyOp(state: EditState, op: EditOp): EditState {
  let tracks: TrackClips[];
  switch (op.type) {
    case "split":
    case "splitAtMarkers":
      tracks = split(state, op);
      break;
    case "cut":
      tracks = cut(state, op);
      break;
    case "silence":
      tracks = silence(state, op);
      break;
    case "gain":
      tracks = gain(state, op);
      break;
    case "move":
      tracks = move(state, op);
      break;
    case "trim":
      tracks = trim(state, op);
      break;
  }
  return {
    ...state,
    tracks: tracks.map((t) =>
      t.clips === state.tracks.find((x) => x.trackId === t.trackId)?.clips
        ? t
        : { ...t, clips: sortClips(t.clips.map(clampFades)) },
    ),
    ops: state.ops + 1,
  };
}

/** The clips after the first `cursor` ops (all by default). */
export function replay(base: EditBase, ops: readonly EditOp[], cursor = ops.length): EditState {
  let state = initialState(base);
  for (const op of ops.slice(0, cursor)) state = applyOp(state, op);
  return state;
}

// ——— validation ————————————————————————————————————————————————————————————————————————

export type EditRefusal =
  | "tooManyOps"
  | "unknownTrack"
  | "unknownClip"
  | "outsideSong"
  | "noChange"
  | "tooManyClips"
  | "tooManyOverlaps";

/** Why an op cannot be added to the state, or null (SPEC §24.3 validation). */
export function validateOp(state: EditState, op: EditOp): EditRefusal | null {
  if (state.ops >= MAX_EDIT_OPS) return "tooManyOps";
  const trackIds = new Set(state.tracks.map((t) => t.trackId));
  const end = songEndFrame(state);
  if ("tracks" in op && op.tracks.some((t) => !trackIds.has(t))) return "unknownTrack";
  if (op.type === "move" && op.toTrackId !== null && !trackIds.has(op.toTrackId))
    return "unknownTrack";
  if (op.type === "move" || op.type === "trim") {
    const ids = op.type === "move" ? op.clipIds : [op.clipId];
    if (locate(state, ids).length !== new Set(ids).size) return "unknownClip";
  }
  if (op.type === "split" || op.type === "splitAtMarkers") {
    if (op.frames.some((f) => f <= 0 || f >= end)) return "outsideSong";
  } else if ("range" in op && op.range.end > end) return "outsideSong";
  const next = applyOp(state, op);
  if (JSON.stringify(next.tracks) === JSON.stringify(state.tracks)) return "noChange";
  if (next.tracks.some((t) => t.clips.length > MAX_CLIPS_PER_TRACK)) return "tooManyClips";
  if (next.tracks.some((t) => maxOverlap(t.clips) > MAX_OVERLAPPING_CLIPS))
    return "tooManyOverlaps";
  return null;
}

/** Tracks whose clips play differently from their clip at the start (what Apply renders). */
export function editedTracks(base: EditBase, state: EditState): string[] {
  return base.tracks
    .filter((t) => {
      const now = state.tracks.find((x) => x.trackId === t.trackId)?.clips ?? [];
      const was = t.clip ? [t.clip] : [];
      return JSON.stringify(canonicalClips(now)) !== JSON.stringify(canonicalClips(was));
    })
    .map((t) => t.trackId);
}
