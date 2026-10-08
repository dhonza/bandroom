import type { CSSProperties, MouseEvent } from "react";
import { setClickSettings, setTrack } from "./controller";

/**
 * Drag-to-paint over the Mixer's M/S buttons: pressing an M (or S) toggles it, and while the
 * pointer stays down every other button of the same kind it passes over is set to that new value
 * (not toggled). Keyboard activation still toggles one button.
 */
export type PaintKind = "mute" | "solo";

/** The id of the click lane's buttons (track buttons use the track id). */
export const CLICK_PAINT_ID = "click";

export interface PaintTarget {
  kind: PaintKind;
  id: string;
}

export type ApplyPaint = (kind: PaintKind, id: string, value: boolean) => void;

/** Sets one M/S button: a track's mute/solo, or the click's (its M is the click switched off). */
export const applyPaint: ApplyPaint = (kind, id, value) => {
  if (id === CLICK_PAINT_ID) {
    setClickSettings(kind === "mute" ? { enabled: !value } : { solo: value });
  } else {
    setTrack(id, kind === "mute" ? { mute: value } : { solo: value });
  }
};

/** One drag: a kind and the value it paints, each button set at most once. */
export class PaintStroke {
  private readonly done = new Set<string>();

  constructor(
    readonly kind: PaintKind,
    readonly value: boolean,
  ) {}

  /** Whether the pointer reaching `target` sets it (same kind, not set yet in this drag). */
  visit(target: PaintTarget | null): boolean {
    if (!target || target.kind !== this.kind || this.done.has(target.id)) return false;
    this.done.add(target.id);
    return true;
  }
}

/** The paintable button an element belongs to, from its `data-paint-*` attributes. */
export function paintTargetOf(el: Element | null): PaintTarget | null {
  const btn = el?.closest("[data-paint-kind]");
  const kind = btn?.getAttribute("data-paint-kind");
  const id = btn?.getAttribute("data-paint-id");
  if ((kind !== "mute" && kind !== "solo") || !id) return null;
  return { kind, id };
}

let active: { end: () => void } | null = null;

/** The parts of a pointerdown a drag needs (some browsers and test DOMs leave fields out). */
export interface PaintPointerDown {
  pointerId: number;
  pointerType?: string;
  button?: number;
  isPrimary?: boolean;
  currentTarget: EventTarget | null;
}

/** The document a drag listens on; `elementFromPoint` is missing in some test DOMs. */
type PaintDocument = Pick<Document, "addEventListener" | "removeEventListener"> & {
  elementFromPoint?: Document["elementFromPoint"];
};

/**
 * Starts a drag on a button: applies `value` to it, then to every button of the same kind the
 * pointer moves over until it is released.
 */
export function startPaint(
  e: PaintPointerDown,
  target: PaintTarget,
  value: boolean,
  apply: ApplyPaint = applyPaint,
  doc: PaintDocument = document,
): void {
  if (e.isPrimary === false || (e.pointerType === "mouse" && e.button !== 0)) return;
  // Touch captures the pointer to the pressed button: release it so moves reach the others.
  const el = e.currentTarget as Partial<Element> | null;
  if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture?.(e.pointerId);
  active?.end();
  const stroke = new PaintStroke(target.kind, value);
  stroke.visit(target);
  apply(target.kind, target.id, value);
  const onMove = (m: globalThis.PointerEvent) => {
    if (m.pointerId !== e.pointerId) return;
    const t = paintTargetOf(doc.elementFromPoint?.(m.clientX, m.clientY) ?? null);
    if (t && stroke.visit(t)) apply(t.kind, t.id, value);
  };
  const onEnd = (m: globalThis.PointerEvent) => {
    if (m.pointerId === e.pointerId) end();
  };
  const end = () => {
    doc.removeEventListener("pointermove", onMove);
    doc.removeEventListener("pointerup", onEnd);
    doc.removeEventListener("pointercancel", onEnd);
    if (active === handle) active = null;
  };
  const handle = { end };
  active = handle;
  doc.addEventListener("pointermove", onMove);
  doc.addEventListener("pointerup", onEnd);
  doc.addEventListener("pointercancel", onEnd);
}

/** Only the M/S buttons take over touch drags; the lanes around them still scroll. */
const PAINT_STYLE: CSSProperties = { touchAction: "none", userSelect: "none" };

/**
 * Props for a paintable M/S button showing `pressed`. A pointer press toggles it and starts a
 * drag; the click that follows is ignored, while keyboard activation (`detail === 0`) toggles.
 */
export function paintProps(kind: PaintKind, id: string, pressed: boolean, apply = applyPaint) {
  return {
    "data-paint-kind": kind,
    "data-paint-id": id,
    style: PAINT_STYLE,
    onPointerDown: (e: PaintPointerDown) => {
      startPaint(e, { kind, id }, !pressed, apply);
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (e.detail === 0) apply(kind, id, !pressed);
    },
  };
}
