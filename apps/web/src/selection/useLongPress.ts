import { useRef, type MouseEvent, type PointerEvent } from "react";
import { LONG_PRESS_MS } from "../lib/gestures";

/** Finger movement that cancels a long-press (it is a scroll). */
const MOVE_TOLERANCE_PX = 10;

/**
 * Long-press on touch (not mouse) starts selection mode (SPEC §26.1). The click that follows a
 * long-press is swallowed, so a row that is a link does not navigate.
 */
export function useLongPress(onLongPress: () => void, enabled: boolean) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    origin.current = null;
  };
  return {
    onPointerDown: (e: PointerEvent) => {
      if (!enabled || e.pointerType === "mouse") return;
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        fired.current = true;
        origin.current = null;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      const o = origin.current;
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture: (e: MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    onContextMenu: (e: MouseEvent) => {
      // Touch browsers open a context menu (or a link preview) on long-press.
      if (enabled && (fired.current || timer.current !== undefined)) e.preventDefault();
    },
  };
}
