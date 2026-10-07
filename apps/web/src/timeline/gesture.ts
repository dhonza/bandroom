import { TAP_SLOP } from "./types";

/**
 * Pointer gestures on the detail view (pure state transitions): tap = seek; touch drag = scroll;
 * mouse drag or ruler drag = select; long-press = menu or, when the finger then moves, select;
 * pinch = zoom.
 */
export type Gesture =
  | { kind: "pending" } // touch: tap, scroll or long-press still possible
  | { kind: "selectPending" } // ruler or mouse: tap or selection drag
  | { kind: "scroll" }
  | { kind: "longPress" }
  | { kind: "select" }
  | { kind: "pinch" };

/** The gesture a single pointer starts: a selection drag is possible on the ruler or by mouse. */
export function startGesture(canSelect: boolean, inRuler: boolean, mouse: boolean): Gesture {
  return canSelect && (inRuler || mouse) ? { kind: "selectPending" } : { kind: "pending" };
}

/** Moved further than a tap allows. */
export function pastTapSlop(x: number, startX: number): boolean {
  return Math.abs(x - startX) > TAP_SLOP;
}

/** The gesture after a pointer move (`moved`: past the tap slop). */
export function moveGesture(g: Gesture, moved: boolean, canSelect: boolean): Gesture {
  if (g.kind === "pending" && moved) return { kind: "scroll" };
  if ((g.kind === "selectPending" || g.kind === "longPress") && moved && canSelect)
    return { kind: "select" };
  return g;
}

/** What lifting a pointer does: end a selection, open the long-press menu, a tap, or nothing. */
export function releaseAction(
  g: Gesture,
  pointersLeft: number,
  canSelect: boolean,
): "select" | "longPress" | "tap" | null {
  if (g.kind === "select" && canSelect) return "select";
  if (g.kind === "longPress") return "longPress";
  if ((g.kind === "pending" || g.kind === "selectPending") && pointersLeft === 0) return "tap";
  return null;
}

export type PinchAxis = "time" | "lanes";

/**
 * What a two-finger pinch zooms, decided when the second finger lands: fingers one above the
 * other (clearly more vertical than horizontal apart) zoom the lane height (SPEC §25.9), side by
 * side they zoom time.
 */
export function pinchAxis(
  a: { x: number; y: number },
  b: { x: number; y: number },
  lanesZoomable: boolean,
): PinchAxis {
  return lanesZoomable && Math.abs(a.y - b.y) > 1.5 * Math.abs(a.x - b.x) ? "lanes" : "time";
}
