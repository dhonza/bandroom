import type { Marker } from "@bandroom/shared";
import { Box } from "@mantine/core";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { secToX, type View } from "../timeline/view";
import { makeSnapper } from "./interaction";
import { orderedRange, type Range } from "./model";
import { setDragging, setSelection, useTimelineUi } from "./store";

/** Selection span with 44 px drag handles; the loop uses a distinct color (SPEC §11.5). */
export function SelectionOverlay({
  view,
  selection,
  loopOn,
  markers,
  durationSec,
  height,
}: {
  view: View;
  selection: Range;
  loopOn: boolean;
  markers: readonly Marker[];
  durationSec: number;
  height: number;
}) {
  const { t } = useTranslation();
  const drag = useRef<{ edge: "start" | "end"; other: number } | null>(null);
  const x0 = secToX(view, selection.start);
  const x1 = secToX(view, selection.end);
  const color = loopOn ? "yellow" : "blue";
  const handle = (edge: "start" | "end", x: number) => (
    <Box
      data-testid={`selection-${edge}`}
      role="slider"
      aria-label={t(edge === "start" ? "markers.selectionStart" : "markers.selectionEnd")}
      aria-valuenow={Math.round(edge === "start" ? selection.start : selection.end)}
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setDragging(true);
        drag.current = { edge, other: edge === "start" ? selection.end : selection.start };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        const snap = makeSnapper(view, markers);
        const sec = snap(
          Math.max(
            0,
            Math.min(durationSec, view.startSec + (e.clientX - rect.left) / view.pxPerSec),
          ),
          e.altKey,
        );
        const picked = useTimelineUi.getState().picked;
        setSelection(orderedRange(sec, d.other), picked);
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      style={{
        position: "absolute",
        left: x - 22,
        width: 44,
        top: 0,
        height,
        pointerEvents: "auto",
        cursor: "ew-resize",
        touchAction: "none",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <Box
        style={{
          width: 3,
          height: "100%",
          background: `var(--mantine-color-${color}-5)`,
          pointerEvents: "none",
        }}
      />
    </Box>
  );
  if (x1 < -22 || x0 > view.widthPx + 22) return null;
  return (
    <>
      <Box
        data-testid="selection"
        data-loop={loopOn || undefined}
        style={{
          position: "absolute",
          left: x0,
          width: Math.max(1, x1 - x0),
          top: 0,
          height,
          background: `var(--mantine-color-${color}-5)`,
          opacity: loopOn ? 0.18 : 0.14,
          pointerEvents: "none",
        }}
      />
      {handle("start", x0)}
      {handle("end", x1)}
    </>
  );
}
