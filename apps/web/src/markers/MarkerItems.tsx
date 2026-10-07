import type { Marker } from "@bandroom/shared";
import { Box, Text } from "@mantine/core";
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { formatClock } from "../player/format";
import { secToX, type View } from "../timeline/view";
import { makeSnapper, tapItem } from "./interaction";
import { dragRange, edgeModeAt, type DragMode, type Range } from "./model";
import { setDragging } from "./store";

export interface ItemProps {
  m: Marker;
  view: View;
  top: number;
  height: number;
  picked: boolean;
  editable: boolean;
  markers: readonly Marker[];
  durationSec: number;
  onCommit: (m: Marker, r: Range) => void;
}

/**
 * Drag a picked item: body = move, edges = resize (sections), with snapping. Unpicked items leave
 * the pointer to the timeline (tap → `onItemTap`, drag → scroll/select).
 */
function useItemDrag({ m, view, markers, durationSec, onCommit, picked, editable }: ItemProps) {
  const [draft, setDraftState] = useState<Range | null>(null);
  const draftRef = useRef<Range | null>(null);
  const setDraft = (r: Range | null) => {
    draftRef.current = r;
    setDraftState(r);
  };
  const drag = useRef<{ x: number; mode: DragMode; moved: boolean } | null>(null);
  const armed = picked && editable;
  const orig = { start: m.startSec, end: m.endSec ?? m.startSec };

  const handlers = armed
    ? {
        onPointerDown: (e: ReactPointerEvent) => {
          // A right click opens the timeline menu (contextmenu), not a drag.
          if (e.pointerType === "mouse" && e.button !== 0) return;
          e.stopPropagation();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const mode = edgeModeAt(m.type === "section", e.clientX, rect);
          drag.current = { x: e.clientX, mode, moved: false };
        },
        onPointerMove: (e: ReactPointerEvent) => {
          const d = drag.current;
          if (!d) return;
          if (!d.moved && Math.abs(e.clientX - d.x) < 6) return;
          if (!d.moved) setDragging(true);
          d.moved = true;
          const dSec = (e.clientX - d.x) / view.pxPerSec;
          const snap = makeSnapper(view, markers, m.id);
          setDraft(
            dragRange(d.mode, orig, dSec, durationSec, m.type === "section", (s) =>
              snap(s, e.altKey),
            ),
          );
        },
        onPointerUp: (e: ReactPointerEvent) => {
          e.stopPropagation();
          const d = drag.current;
          drag.current = null;
          const r = draftRef.current;
          setDraft(null);
          setDragging(false);
          if (d?.moved && r) onCommit(m, r);
          else if (d && !d.moved) tapItem(m, true);
        },
        onPointerCancel: () => {
          drag.current = null;
          setDraft(null);
          setDragging(false);
        },
      }
    : {};
  return { draft, handlers, armed };
}

/** Keyboard and a11y props shared by section and marker items. */
function itemA11y(m: Marker, picked: boolean, editable: boolean) {
  return {
    role: "button",
    tabIndex: 0,
    "data-timeline-item": m.id,
    "data-picked": picked || undefined,
    "aria-pressed": picked,
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key === "Enter") {
        e.stopPropagation();
        tapItem(m, editable);
      }
    },
  };
}

export function SectionItem(props: ItemProps) {
  const { t } = useTranslation();
  const { m, view, top, height, picked } = props;
  const { draft, handlers, armed } = useItemDrag(props);
  const start = draft?.start ?? m.startSec;
  const end = draft?.end ?? m.endSec ?? m.startSec;
  const x0 = secToX(view, start);
  const x1 = secToX(view, end);
  if (x1 < -2 || x0 > view.widthPx + 2) return null;
  return (
    <Box
      component="div"
      {...itemA11y(m, picked, props.editable)}
      data-testid="section-item"
      aria-label={t("markers.sectionLabel", {
        name: m.name,
        start: formatClock(m.startSec, false),
        end: formatClock(m.endSec ?? m.startSec, false),
      })}
      {...handlers}
      style={{
        position: "absolute",
        left: x0,
        width: Math.max(2, x1 - x0),
        top: top + 1,
        height: height - 2,
        pointerEvents: "auto",
        borderRadius: 4,
        background: `var(--mantine-color-${m.color}-light)`,
        borderLeft: `3px solid var(--mantine-color-${m.color}-filled)`,
        outline: picked ? `2px solid var(--mantine-color-${m.color}-filled)` : undefined,
        outlineOffset: -2,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        paddingInline: 6,
        cursor: armed ? "grab" : "pointer",
        touchAction: armed ? "none" : "pan-y",
      }}
    >
      <Text
        size="xs"
        fw={700}
        truncate
        c={`var(--mantine-color-${m.color}-light-color)`}
        style={{ pointerEvents: "none" }}
      >
        {m.name}
      </Text>
    </Box>
  );
}

export function MarkerItem(props: ItemProps) {
  const { t } = useTranslation();
  const { m, view, top, height, picked } = props;
  const { draft, handlers, armed } = useItemDrag(props);
  const x = secToX(view, draft?.start ?? m.startSec);
  if (x < -120 || x > view.widthPx + 2) return null;
  return (
    <Box
      {...itemA11y(m, picked, props.editable)}
      data-testid="marker-item"
      aria-label={t("markers.markerLabel", { name: m.name, at: formatClock(m.startSec, false) })}
      {...handlers}
      style={{
        position: "absolute",
        left: x - 6,
        top,
        height,
        minWidth: 44,
        maxWidth: 140,
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingLeft: 6,
        paddingRight: 4,
        cursor: armed ? "grab" : "pointer",
        touchAction: armed ? "none" : "pan-y",
      }}
    >
      <Box
        style={{
          position: "absolute",
          left: 5,
          top: 2,
          bottom: 2,
          width: 2,
          background: `var(--mantine-color-${m.color}-filled)`,
          pointerEvents: "none",
        }}
      />
      <Text
        size="xs"
        fw={600}
        truncate
        px={4}
        style={{
          pointerEvents: "none",
          borderRadius: 3,
          background: picked
            ? `var(--mantine-color-${m.color}-filled)`
            : `var(--mantine-color-${m.color}-light)`,
          color: picked
            ? "var(--mantine-color-white)"
            : `var(--mantine-color-${m.color}-light-color)`,
        }}
      >
        {m.name}
      </Text>
    </Box>
  );
}
