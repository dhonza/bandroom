/**
 * Piecewise time maps (SPEC §24.4): base time → edited time. Each piece moves `[start, end)` by
 * `delta`; time outside every piece was deleted. A point exactly at the end of a piece followed by
 * a deleted interval still belongs to that piece, so both edges of a cut survive and meet at the
 * join. Units are the caller's (frames or seconds). A constant shift is a one-piece map.
 */

export interface TimePiece {
  start: number;
  end: number;
  delta: number;
}

export interface TimeMap {
  readonly pieces: readonly TimePiece[];
}

export const shiftTimeMap = (delta: number): TimeMap => ({
  pieces: [{ start: -Infinity, end: Infinity, delta }],
});

/** `[start, end)` removed, everything after moves left by its length. */
export const cutTimeMap = (start: number, end: number): TimeMap => ({
  pieces: [
    { start: -Infinity, end: start, delta: 0 },
    { start: end, end: Infinity, delta: start - end },
  ],
});

/** `[start, end)` moved by `delta`; everything else stays. */
export const moveTimeMap = (start: number, end: number, delta: number): TimeMap => ({
  pieces: [
    { start: -Infinity, end: start, delta: 0 },
    { start, end, delta },
    { start: end, end: Infinity, delta: 0 },
  ],
});

/** The same map in other units (frames → seconds: `1 / 48000`). */
export const scaleTimeMap = (map: TimeMap, k: number): TimeMap => ({
  pieces: map.pieces.map((p) => ({ start: p.start * k, end: p.end * k, delta: p.delta * k })),
});

function pieceAt(map: TimeMap, t: number): TimePiece | undefined {
  return map.pieces.find((p) => p.start <= t && t < p.end) ?? map.pieces.find((p) => p.end === t);
}

/**
 * A point through the map: null when it was deleted. Edited times never go below 0 (`clamp`);
 * pass `false` for values that may (bar 1 of a tempo map).
 */
export function mapTime(map: TimeMap, t: number, clamp = true): number | null {
  const p = pieceAt(map, t);
  if (!p) return null;
  return clamp ? Math.max(0, t + p.delta) : t + p.delta;
}

/**
 * A range through the map: edges inside deleted time move inwards to the surviving audio; null
 * when nothing of it survives (or it collapses to a point).
 */
export function mapTimeRange(
  map: TimeMap,
  start: number,
  end: number,
): { start: number; end: number } | null {
  const from = pieceAt(map, start)
    ? start
    : (map.pieces.find((p) => p.start > start)?.start ?? Infinity);
  const to = pieceAt(map, end) ? end : (map.pieces.findLast((p) => p.end < end)?.end ?? -Infinity);
  if (!(from < to)) return null;
  const a = mapTime(map, from) as number;
  const b = mapTime(map, to) as number;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return hi > lo ? { start: lo, end: hi } : null;
}
