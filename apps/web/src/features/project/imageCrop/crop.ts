/**
 * Square crop geometry for the project image dialog (SPEC §25.4), in image pixels. Pure
 * functions so the dialog's behaviour is testable without a browser.
 */

export interface Square {
  x: number;
  y: number;
  size: number;
}

export interface Bounds {
  width: number;
  height: number;
}

export type Corner = "nw" | "ne" | "sw" | "se";

/** Largest output side: the browser crops to at most this many pixels. */
export const MAX_OUTPUT = 1024;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The smallest selection: 32 px, or the whole short side of a tiny image. */
export function minSide(b: Bounds): number {
  return Math.min(32, b.width, b.height);
}

/** The largest centred square. */
export function defaultSquare(b: Bounds): Square {
  const size = Math.min(b.width, b.height);
  return { x: (b.width - size) / 2, y: (b.height - size) / 2, size };
}

/** Keeps the square inside the image and between the minimum and the short side. */
export function clampSquare(s: Square, b: Bounds): Square {
  const size = clamp(s.size, minSide(b), Math.min(b.width, b.height));
  return { x: clamp(s.x, 0, b.width - size), y: clamp(s.y, 0, b.height - size), size };
}

export function moveSquare(start: Square, dx: number, dy: number, b: Bounds): Square {
  return clampSquare({ ...start, x: start.x + dx, y: start.y + dy }, b);
}

/**
 * Drags `corner` by (dx, dy) while the opposite corner stays put. The size follows the mean of
 * the two movements along the corner's diagonal, limited by the room towards that corner.
 */
export function resizeFromCorner(
  start: Square,
  corner: Corner,
  dx: number,
  dy: number,
  b: Bounds,
): Square {
  const sx = corner === "ne" || corner === "se" ? 1 : -1;
  const sy = corner === "sw" || corner === "se" ? 1 : -1;
  // The fixed corner.
  const ax = sx === 1 ? start.x : start.x + start.size;
  const ay = sy === 1 ? start.y : start.y + start.size;
  const room = Math.min(sx === 1 ? b.width - ax : ax, sy === 1 ? b.height - ay : ay);
  const size = clamp(start.size + (sx * dx + sy * dy) / 2, Math.min(minSide(b), room), room);
  return { x: sx === 1 ? ax : ax - size, y: sy === 1 ? ay : ay - size, size };
}

/**
 * Keyboard control: arrows move, `+`/`-` grow or shrink around the centre. `step` is in image
 * pixels (callers pass a larger step with Shift). Returns null for other keys.
 */
export function nudgeSquare(s: Square, key: string, step: number, b: Bounds): Square | null {
  switch (key) {
    case "ArrowLeft":
      return moveSquare(s, -step, 0, b);
    case "ArrowRight":
      return moveSquare(s, step, 0, b);
    case "ArrowUp":
      return moveSquare(s, 0, -step, b);
    case "ArrowDown":
      return moveSquare(s, 0, step, b);
    case "+":
    case "=":
    case "-":
    case "_": {
      const grow = key === "+" || key === "=" ? step : -step;
      const size = clamp(s.size + 2 * grow, minSide(b), Math.min(b.width, b.height));
      const c = s.size / 2;
      return clampSquare({ x: s.x + c - size / 2, y: s.y + c - size / 2, size }, b);
    }
    default:
      return null;
  }
}

/** Output side in pixels: the selection's size, at most {@link MAX_OUTPUT}, never below 1. */
export function outputSide(s: Square): number {
  return Math.max(1, Math.min(MAX_OUTPUT, Math.round(s.size)));
}
