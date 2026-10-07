import { alpha, Box } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  moveSquare,
  nudgeSquare,
  resizeFromCorner,
  type Bounds,
  type Corner,
  type Square,
} from "./crop";

/** Touch area of a corner handle (SPEC §11: ≥ 44 px), centred on the corner. */
const HANDLE = 44;
const KNOB = 16;
const CORNERS: readonly Corner[] = ["nw", "ne", "sw", "se"];
const SHADE = alpha("var(--mantine-color-black)", 0.55);
const LINE = "var(--mantine-color-white)";

type Drag = { kind: "move" } | { kind: "resize"; corner: Corner };

/**
 * A fitted image with a square selection (SPEC §25.4): drag inside to move, drag a corner to
 * resize; with focus, arrow keys move and +/- resize (Shift for bigger steps). The value is in
 * image pixels.
 */
export function SquareCropper({
  src,
  bounds,
  value,
  onChange,
  maxHeight,
}: {
  src: string;
  bounds: Bounds;
  value: Square;
  onChange: (s: Square) => void;
  /** Largest displayed height in px. */
  maxHeight: number;
}) {
  const { t } = useTranslation();
  const { ref, width } = useElementSize();
  const drag = useRef<{ mode: Drag; x: number; y: number; start: Square; id: number } | null>(null);
  // The handles stick out by half their touch area; keep room for them around the image.
  const room = Math.max(0, width - HANDLE);
  const scale = Math.min(room / bounds.width, (maxHeight - HANDLE) / bounds.height) || 0;
  const w = bounds.width * scale;
  const h = bounds.height * scale;
  const sel = { x: value.x * scale, y: value.y * scale, size: value.size * scale };

  // One handler for the selection (move) and the corners (resize, `data-corner`).
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || scale === 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const corner = e.currentTarget.dataset.corner as Corner | undefined;
    const mode: Drag = corner ? { kind: "resize", corner } : { kind: "move" };
    drag.current = { mode, x: e.clientX, y: e.clientY, start: value, id: e.pointerId };
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = (e.clientX - d.x) / scale;
    const dy = (e.clientY - d.y) / scale;
    onChange(
      d.mode.kind === "move"
        ? moveSquare(d.start, dx, dy, bounds)
        : resizeFromCorner(d.start, d.mode.corner, dx, dy, bounds),
    );
  };
  const end = (e: PointerEvent<HTMLElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const shortSide = Math.min(bounds.width, bounds.height);
    const step = Math.max(1, Math.round(shortSide * (e.shiftKey ? 0.1 : 0.01)));
    const next = nudgeSquare(value, e.key, step, bounds);
    if (!next) return;
    e.preventDefault();
    onChange(next);
  };
  const pointer = { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end };

  const shade = (style: CSSProperties) => (
    <Box style={{ position: "absolute", background: SHADE, pointerEvents: "none", ...style }} />
  );
  return (
    <Box ref={ref} w="100%" data-testid="crop-area">
      <Box
        style={{
          position: "relative",
          width: w,
          height: h,
          margin: `${String(HANDLE / 2)}px auto`,
          touchAction: "none",
          userSelect: "none",
        }}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          style={{ display: "block", width: w, height: h, pointerEvents: "none" }}
        />
        {shade({ left: 0, top: 0, width: w, height: sel.y })}
        {shade({ left: 0, top: sel.y + sel.size, width: w, height: h - sel.y - sel.size })}
        {shade({ left: 0, top: sel.y, width: sel.x, height: sel.size })}
        {shade({
          left: sel.x + sel.size,
          top: sel.y,
          width: w - sel.x - sel.size,
          height: sel.size,
        })}
        <Box
          role="group"
          aria-roledescription={t("projects.settings.crop.selection")}
          aria-label={t("projects.settings.crop.selectionLabel")}
          tabIndex={0}
          data-testid="crop-selection"
          onKeyDown={onKeyDown}
          {...pointer}
          style={{
            position: "absolute",
            left: sel.x,
            top: sel.y,
            width: sel.size,
            height: sel.size,
            outline: `2px solid ${LINE}`,
            cursor: "move",
            touchAction: "none",
          }}
        >
          {CORNERS.map((corner) => (
            <Box
              key={corner}
              data-testid={`crop-handle-${corner}`}
              aria-hidden
              data-corner={corner}
              {...pointer}
              style={{
                position: "absolute",
                width: HANDLE,
                height: HANDLE,
                [corner.includes("n") ? "top" : "bottom"]: -HANDLE / 2,
                [corner.includes("w") ? "left" : "right"]: -HANDLE / 2,
                cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
                touchAction: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Box
                style={{
                  width: KNOB,
                  height: KNOB,
                  background: LINE,
                  borderRadius: 3,
                  boxShadow: `0 0 0 1px ${SHADE}`,
                }}
              />
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
