import { Box, Button, useComputedColorScheme } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { IconFocusCentered } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LONG_PRESS_MS } from "../lib/gestures";
import { drawClickLane } from "./clickLane";
import { moveGesture, pastTapSlop, releaseAction, startGesture, type Gesture } from "./gesture";
import {
  cssColor,
  drawGrid,
  drawGuides,
  drawLaneTint,
  drawOverview,
  drawPlayheadLine,
  drawRuler,
  drawViewportBox,
  drawWaveform,
  setupCanvas,
  type Lane,
} from "./render";
import { detailLayout, OVERVIEW_H, PAUSED_POLL_MS, RULER_H, type TimelineProps } from "./types";
import {
  centerOn,
  clampSec,
  clampView,
  fitAll,
  fitRange,
  follow,
  scrollBy,
  secToX,
  viewportOn,
  wheelView,
  xToSec,
  zoomAt,
  type View,
} from "./view";
import { LANE_STEP, MAX_LANE_H, MIN_LANE_H, clampLaneHeight, zoomLaneHeight } from "./laneHeight";
import { pinchAxis, type PinchAxis } from "./gesture";
import { ZoomControls } from "./ZoomControls";
import { onZoomRequest, onZoomToRangeRequest } from "./zoom";

export type { TimelineMark, TimelineProps, TimeRange } from "./types";

const NO_LANES: Lane[] = [];
export { detailLayout, RULER_H } from "./types";
export { requestZoom, requestZoomToRange, ZOOM_EVENT } from "./zoom";

/**
 * Canvas timeline (SPEC §11.6): overview strip (whole song, sections, the audible lanes summed,
 * viewport box; tap/drag = seek) and a zoomable detail view with ruler,
 * DOM lanes for sections and markers, and one waveform lane per track unless `hideLanes`. Layered canvases: waveforms are redrawn only on view changes, the
 * playhead every animation frame without React re-renders.
 */
export function Timeline({
  lanes,
  durationSec,
  getPosition,
  playing,
  onSeek,
  laneHeight = 56,
  onLaneHeight,
  minLaneHeight = MIN_LANE_H,
  hideLanes = false,
  overviewHeight = OVERVIEW_H,
  belowOverview,
  renderHeader,
  headerWidth = 0,
  topLanesHeight = 0,
  renderTopHeader,
  renderCorner,
  labelWidth = 0,
  renderOverlay,
  bands,
  guides,
  overviewRange,
  overviewRangeColor,
  zoomRange = null,
  onSelectDrag,
  onLongPress,
  onItemTap,
  grid = null,
}: TimelineProps) {
  const { t } = useTranslation();
  const { ref: sizeRef, width: fullWidth } = useElementSize();
  // Mixer open: the track-header column. Mixer closed: a narrow column with the top-lane labels,
  // while some top lane is shown or there is a corner (the lanes menu) (SPEC §11.3).
  const trackHeaders = !!renderHeader && !hideLanes;
  const labelColumn =
    hideLanes &&
    labelWidth > 0 &&
    ((!!renderTopHeader && topLanesHeight > 0) || renderCorner !== undefined);
  const headerW = trackHeaders ? headerWidth : labelColumn ? labelWidth : 0;
  const width = Math.max(0, fullWidth - headerW);
  // The overview is indented by the header column like the ruler and the lanes, so a time has the
  // same x in all of them when the detail view shows the whole song (SPEC §11.3).
  const overviewW = width;
  const overviewH = overviewHeight;
  // The stored view is reconciled with the current width/length during render (no effect needed).
  const [rawView, setView] = useState<View | null>(null);
  const view = useMemo(() => {
    if (width <= 0 || durationSec <= 0) return null;
    if (!rawView) return fitAll(durationSec, width);
    if (rawView.widthPx === width && rawView.durationSec === durationSec) return rawView;
    return clampView({ ...rawView, widthPx: width, durationSec });
  }, [rawView, width, durationSec]);
  const [followOn, setFollowOn] = useState(true);
  // Refs let the rAF loop and gesture handlers read the latest values without re-subscribing.
  const viewRef = useRef<View | null>(view);
  const followRef = useRef(followOn);
  useEffect(() => {
    viewRef.current = view;
    followRef.current = followOn;
  }, [view, followOn]);

  const overviewRef = useRef<HTMLCanvasElement>(null);
  /** The overview's playhead: an overlay, so the overview itself is not repainted per frame. */
  const overviewHeadRef = useRef<HTMLCanvasElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const dynamicRef = useRef<HTMLCanvasElement>(null);
  const { lanesTop, height: detailH } = detailLayout({
    laneCount: lanes.length,
    laneHeight,
    topLanesHeight,
    hideLanes,
  });
  const lanesShown = hideLanes ? NO_LANES : lanes;

  // Canvas colors are resolved per draw (cached in cssColor); a theme switch redraws.
  const scheme = useComputedColorScheme("dark");
  const colors = useCallback(
    () => ({
      text: cssColor("--mantine-color-dimmed"),
      line: cssColor("--mantine-color-default-border"),
      bar: cssColor("--mantine-color-text", "#ccc"),
      playhead: cssColor("--mantine-color-red-6", "#e03131"),
    }),
    [],
  );

  // Static layer: ruler + waveforms + marker guides.
  useEffect(() => {
    const c = staticRef.current;
    if (!c || !view) return;
    const ctx = setupCanvas(c, view.widthPx, detailH);
    if (!ctx) return;
    const pal = colors();
    ctx.clearRect(0, 0, view.widthPx, detailH);
    lanesShown.forEach((lane, i) => {
      if (lane.tint) {
        const color = cssColor(`--mantine-color-${lane.color}-6`);
        drawLaneTint(ctx, view.widthPx, lanesTop + i * laneHeight, laneHeight, color);
      }
    });
    if (grid) drawGrid(ctx, view, grid, RULER_H, detailH, pal);
    else drawRuler(ctx, view, RULER_H, pal);
    lanesShown.forEach((lane, i) => {
      if (lane.click) {
        drawClickLane(
          ctx,
          view,
          lane.click,
          lanesTop + i * laneHeight + 2,
          laneHeight - 4,
          cssColor(`--mantine-color-${lane.color}-4`),
          lane.dimmed ? 0.3 : 1,
        );
        return;
      }
      ctx.globalAlpha = lane.dimmed ? 0.3 : 1;
      drawWaveform(
        ctx,
        view,
        lane,
        lanesTop + i * laneHeight + 2,
        laneHeight - 4,
        cssColor(`--mantine-color-${lane.color}-5`),
      );
    });
    drawGuides(ctx, view, guides ?? [], lanesTop, detailH);
  }, [view, lanesShown, detailH, laneHeight, colors, lanesTop, guides, grid, scheme]);

  // Overview: sections, the audible lanes summed visually (max) and the loop are drawn once into
  // an offscreen canvas; scrolling and zooming only copy it and draw the viewport box.
  const overviewBase = useRef<HTMLCanvasElement | null>(null);
  const hasView = view !== null;
  const paintOverview = useCallback(() => {
    const c = overviewRef.current;
    const base = overviewBase.current;
    const v = viewRef.current;
    if (!c || !base || !v || overviewW <= 0) return;
    const ctx = setupCanvas(c, overviewW, overviewH);
    if (!ctx) return;
    ctx.clearRect(0, 0, overviewW, overviewH);
    ctx.drawImage(base, 0, 0, overviewW, overviewH);
    const { x0, x1 } = viewportOn(fitAll(durationSec, overviewW), v);
    drawViewportBox(ctx, x0, x1, overviewH);
  }, [durationSec, overviewW, overviewH]);

  useEffect(() => {
    if (overviewW <= 0 || !hasView) return;
    const base = overviewBase.current ?? document.createElement("canvas");
    overviewBase.current = base;
    const ctx = setupCanvas(base, overviewW, overviewH);
    if (!ctx) return;
    ctx.clearRect(0, 0, overviewW, overviewH);
    drawOverview(ctx, fitAll(durationSec, overviewW), overviewH, {
      bands: bands ?? [],
      lanes,
      range: overviewRange,
      rangeColor: overviewRangeColor ?? "yellow",
    });
    paintOverview();
  }, [
    overviewW,
    overviewH,
    hasView,
    lanes,
    durationSec,
    bands,
    overviewRange,
    overviewRangeColor,
    scheme,
    paintOverview,
  ]);

  // Dynamic layer: the playhead, in the detail view and on the overview. While playing it is
  // redrawn every animation frame and follow mode pages the view; while paused there is no rAF
  // loop: it is redrawn when the view changes or a seek moved it (checked a few times a second).
  // Each canvas is cleared and redrawn only when its rounded playhead x changes.
  const drawPlayhead = useRef<(() => void) | null>(null);
  useEffect(() => {
    let drawnX = Number.NaN;
    let drawnW = 0;
    let drawnOverviewX = Number.NaN;
    let drawnSec = 0;
    const overviewView = durationSec > 0 && overviewW > 0 ? fitAll(durationSec, overviewW) : null;
    const drawOverviewHead = (pos: number) => {
      const c = overviewHeadRef.current;
      if (!c || !overviewView) return;
      const x = Math.round(secToX(overviewView, pos)) + 0.5;
      if (x === drawnOverviewX) return;
      drawnOverviewX = x;
      const ctx = setupCanvas(c, overviewW, overviewH);
      if (!ctx) return;
      ctx.clearRect(0, 0, overviewW, overviewH);
      if (x >= 0 && x <= overviewW) drawPlayheadLine(ctx, x, overviewH, colors().playhead);
    };
    const draw = () => {
      const v = viewRef.current;
      const c = dynamicRef.current;
      if (!v || !c) return;
      const pos = getPosition();
      const sec = Math.round(pos);
      if (sec !== drawnSec) {
        drawnSec = sec;
        overviewRef.current?.setAttribute("aria-valuenow", String(sec));
      }
      if (followRef.current && playing) {
        const f = follow(v, pos);
        if (f !== v) setView(f);
      }
      drawOverviewHead(pos);
      const x = Math.round(secToX(v, pos)) + 0.5;
      if (x === drawnX && v.widthPx === drawnW) return;
      drawnX = x;
      drawnW = v.widthPx;
      const ctx = setupCanvas(c, v.widthPx, detailH);
      if (!ctx) return;
      ctx.clearRect(0, 0, v.widthPx, detailH);
      if (x >= 0 && x <= v.widthPx) drawPlayheadLine(ctx, x, detailH, colors().playhead);
    };
    drawPlayhead.current = draw;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      draw();
      if (playing) raf = requestAnimationFrame(tick);
      else timer = setTimeout(tick, PAUSED_POLL_MS);
    };
    tick();
    return () => {
      drawPlayhead.current = null;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [getPosition, playing, detailH, colors, scheme, durationSec, overviewW, overviewH]);

  // A new view (scroll, zoom, resize) moves the playhead and the overview box right away.
  useEffect(() => {
    drawPlayhead.current?.();
    paintOverview();
  }, [view, paintOverview]);

  // --- Gestures on the detail view --------------------------------------------------------
  // tap = seek; touch drag = scroll; mouse drag or ruler drag = select; long-press = menu or,
  // when the finger then moves, select; pinch = zoom.
  const pointers = useRef(new Map<number, { x: number; y: number; startX: number }>());
  const pinchDist = useRef<number | null>(null);
  /** A two-finger pinch zooms time (fingers side by side) or lane height (one above the other). */
  const pinch = useRef<{ axis: PinchAxis; dist: number; height: number } | null>(null);
  const laneHeightRef = useRef(laneHeight);
  const minLaneRef = useRef(minLaneHeight);
  useEffect(() => {
    laneHeightRef.current = laneHeight;
    minLaneRef.current = minLaneHeight;
  }, [laneHeight, minLaneHeight]);
  const gesture = useRef<Gesture>({ kind: "pending" });
  const anchor = useRef({ sec: 0, clientX: 0, clientY: 0, item: null as string | null });
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  useEffect(() => clearPress, []);

  /** The last pointer's type: only a mouse's right click opens the menu by `contextmenu`. */
  const lastPointerType = useRef("mouse");
  const localX = (e: React.PointerEvent | React.WheelEvent | React.MouseEvent) =>
    e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left;
  const localY = (e: React.PointerEvent) =>
    e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top;
  const secAt = (v: View, x: number) => clampSec(xToSec(v, x), durationSec);

  const onPointerDown = (e: React.PointerEvent) => {
    const v = viewRef.current;
    if (!v) return;
    // A right click opens the context menu (desktop); it neither seeks nor selects.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const x = localX(e);
    pointers.current.set(e.pointerId, { x, y: localY(e), startX: x });
    if (pointers.current.size === 2) {
      clearPress();
      gesture.current = { kind: "pinch" };
      const [a, b] = [...pointers.current.values()];
      pinchDist.current = a && b ? Math.abs(a.x - b.x) : null;
      const axis = a && b ? pinchAxis(a, b, !!onLaneHeight) : "time";
      pinch.current =
        a && b ? { axis, dist: Math.abs(a.y - b.y), height: laneHeightRef.current } : null;
      return;
    }
    const item =
      (e.target as Element | null)
        ?.closest("[data-timeline-item]")
        ?.getAttribute("data-timeline-item") ?? null;
    anchor.current = { sec: secAt(v, x), clientX: e.clientX, clientY: e.clientY, item };
    const inRuler = localY(e) < RULER_H;
    const mouse = e.pointerType === "mouse";
    gesture.current = startGesture(!!onSelectDrag, inRuler, mouse);
    if (!mouse && gesture.current.kind === "pending") {
      clearPress();
      pressTimer.current = setTimeout(() => {
        if (gesture.current.kind === "pending") {
          gesture.current = { kind: "longPress" };
          if ("vibrate" in navigator) navigator.vibrate(10);
        }
      }, LONG_PRESS_MS);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointers.current.get(e.pointerId);
    const v = viewRef.current;
    if (!p || !v) return;
    const x = localX(e);
    const dx = x - p.x;
    p.x = x;
    p.y = localY(e);
    const g = gesture.current;
    if (g.kind === "pinch") {
      const [a, b] = [...pointers.current.values()];
      const pc = pinch.current;
      if (a && b && pc?.axis === "lanes") {
        if (pc.dist > 0)
          onLaneHeight?.(
            clampLaneHeight((pc.height * Math.abs(a.y - b.y)) / pc.dist, minLaneRef.current),
          );
        return;
      }
      if (a && b && pinchDist.current) {
        const d = Math.abs(a.x - b.x);
        setView(zoomAt(v, (a.x + b.x) / 2, d / pinchDist.current));
        pinchDist.current = d;
        setFollowOn(false);
      }
      return;
    }
    const now = moveGesture(g, pastTapSlop(x, p.startX), !!onSelectDrag);
    if (now !== g) {
      if (now.kind === "scroll") clearPress();
      gesture.current = now;
    }
    if (now.kind === "scroll") {
      setView(scrollBy(v, -dx));
      setFollowOn(false);
    } else if (now.kind === "select" && onSelectDrag) {
      onSelectDrag(anchor.current.sec, secAt(v, x), "move", v);
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    // Only pointers that went down on the view end a gesture: a release that bubbles up from a
    // control on it (the Recenter button) or a right click's release would otherwise be a tap.
    if (!pointers.current.has(e.pointerId)) return;
    const v = viewRef.current;
    clearPress();
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) {
      pinchDist.current = null;
      pinch.current = null;
    }
    if (!v || e.type === "pointercancel") {
      gesture.current = { kind: "pending" };
      return;
    }
    const action = releaseAction(g, pointers.current.size, !!onSelectDrag);
    if (action === "select") {
      onSelectDrag?.(anchor.current.sec, secAt(v, localX(e)), "end", v);
    } else if (action === "longPress") {
      onLongPress?.(
        anchor.current.sec,
        anchor.current.clientX,
        anchor.current.clientY,
        anchor.current.item,
      );
    } else if (action === "tap") {
      const item = anchor.current.item;
      if (item && onItemTap) onItemTap(item, secAt(v, localX(e)));
      else {
        onSeek(secAt(v, localX(e)));
        drawPlayhead.current?.();
      }
    }
    if (pointers.current.size === 0) gesture.current = { kind: "pending" };
  };
  const onWheel = (e: React.WheelEvent) => {
    const v = viewRef.current;
    if (!v || (e.altKey && onLaneHeight)) return; // lane height: the native listener below
    const next = wheelView(v, {
      x: localX(e),
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
    });
    if (!next) return;
    if (next.zoom) e.preventDefault();
    setView(next.view);
    setFollowOn(false);
  };

  const overviewSeek = (e: React.PointerEvent) => {
    const v = viewRef.current;
    if (!v || (e.type === "pointermove" && e.buttons === 0)) return;
    const sec = clampSec(xToSec(fitAll(durationSec, overviewW), localX(e)), durationSec);
    onSeek(sec);
    setView(centerOn(v, sec));
    drawPlayhead.current?.();
  };

  // Alt/Option+wheel sets the lane height (SPEC §25.9). A native listener, because React's wheel
  // listener is passive and the page would scroll as well.
  const detailRef = useRef<HTMLDivElement>(null);
  const laneSetter = useRef(onLaneHeight);
  useEffect(() => {
    laneSetter.current = onLaneHeight;
  }, [onLaneHeight]);
  useEffect(() => {
    const el = detailRef.current;
    if (!el) return;
    const onAltWheel = (e: WheelEvent) => {
      const set = laneSetter.current;
      if (!e.altKey || !set || e.deltaY === 0) return;
      e.preventDefault();
      set(zoomLaneHeight(laneHeightRef.current, Math.exp(-e.deltaY * 0.002), minLaneRef.current));
    };
    el.addEventListener("wheel", onAltWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onAltWheel);
    };
  }, []);

  const zoom = useCallback((factor: number) => {
    const v = viewRef.current;
    if (v) setView(zoomAt(v, v.widthPx / 2, factor));
  }, []);

  useEffect(() => onZoomRequest(zoom), [zoom]);

  const zoomToRange = useCallback(() => {
    const v = viewRef.current;
    if (!v || !zoomRange) return;
    setView(fitRange(v, zoomRange.start, zoomRange.end));
    setFollowOn(false);
  }, [zoomRange]);
  useEffect(() => onZoomToRangeRequest(zoomToRange), [zoomToRange]);

  return (
    <Box
      ref={sizeRef}
      pos="relative"
      data-testid="timeline"
      data-lanes={lanesShown.length}
      data-overview-height={overviewH}
    >
      <Box style={{ display: "flex" }}>
        {headerW > 0 && (
          // The corner left of the overview (the lanes menu), as wide as the header column.
          <Box w={headerW} style={{ flex: "none", minWidth: 0 }} data-testid="timeline-corner">
            {renderCorner?.()}
          </Box>
        )}
        <Box pos="relative" style={{ flex: "1 1 auto", minWidth: 0 }}>
          <canvas
            ref={overviewRef}
            style={{
              display: "block",
              width: overviewW || "100%",
              height: overviewH,
              cursor: "pointer",
              touchAction: "pan-y",
              borderRadius: 4,
              background: "var(--mantine-color-default-hover)",
            }}
            onPointerDown={overviewSeek}
            onPointerMove={overviewSeek}
            aria-label={t("timeline.overview")}
            role="slider"
            aria-valuemin={0}
            aria-valuemax={Math.round(durationSec)}
            // Kept current by the playhead loop below (no re-render per second).
            aria-valuenow={0}
            data-testid="timeline-overview"
          />
          <canvas
            ref={overviewHeadRef}
            style={{
              display: "block",
              position: "absolute",
              inset: 0,
              width: overviewW || "100%",
              height: overviewH,
              pointerEvents: "none",
            }}
            data-testid="timeline-overview-playhead"
          />
        </Box>
      </Box>
      {belowOverview && <Box mt={6}>{belowOverview}</Box>}
      <Box mt={6} style={{ display: "flex", alignItems: "flex-start" }}>
        {(trackHeaders || labelColumn) && (
          <Box
            w={headerW}
            style={{ flex: "none", paddingTop: RULER_H }}
            data-testid={trackHeaders ? "track-headers" : "lane-labels"}
          >
            {topLanesHeight > 0 && (
              <Box h={topLanesHeight} style={{ overflow: "hidden" }}>
                {renderTopHeader?.()}
              </Box>
            )}
            {lanesShown.map((lane, i) => (
              <Box key={lane.id} h={laneHeight} style={{ overflow: "hidden" }}>
                {renderHeader?.(i)}
              </Box>
            ))}
          </Box>
        )}
        <Box
          pos="relative"
          style={{
            touchAction: "pan-y",
            cursor: "crosshair",
            outlineOffset: 2,
            flex: "1 1 auto",
            minWidth: 0,
            userSelect: "none",
            WebkitUserSelect: "none",
            WebkitTouchCallout: "none",
          }}
          onPointerDownCapture={(e) => {
            lastPointerType.current = e.pointerType;
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => {
            e.preventDefault();
            // Touch and pen open the menu by long-press (their contextmenu would open it twice).
            const v = viewRef.current;
            if (!v || !onLongPress || lastPointerType.current !== "mouse") return;
            const item =
              (e.target as Element | null)
                ?.closest("[data-timeline-item]")
                ?.getAttribute("data-timeline-item") ?? null;
            onLongPress(secAt(v, localX(e)), e.clientX, e.clientY, item);
          }}
          onWheel={onWheel}
          ref={detailRef}
          data-testid="timeline-detail"
          data-lane-height={laneHeight}
          // The visible seconds, for tests and debugging.
          data-view={
            view
              ? `${view.startSec.toFixed(2)},${(view.startSec + view.widthPx / view.pxPerSec).toFixed(2)}`
              : undefined
          }
          aria-label={t("timeline.detail")}
        >
          <canvas
            ref={staticRef}
            style={{ display: "block" }}
            // Waveform scale per lane (version gain, SPEC §25.6) for tests and debugging.
            data-lane-scales={lanes.map((l) => (l.scale ?? 1).toFixed(3)).join(",")}
          />
          <canvas
            ref={dynamicRef}
            style={{ display: "block", position: "absolute", inset: 0, pointerEvents: "none" }}
          />
          {view && renderOverlay && (
            <Box
              pos="absolute"
              style={{ inset: 0, pointerEvents: "none", overflow: "hidden" }}
              data-testid="timeline-overlay"
            >
              {renderOverlay(view)}
            </Box>
          )}
          {!followOn && playing && (
            <Button
              size="compact-sm"
              radius="xl"
              leftSection={<IconFocusCentered size={14} />}
              pos="absolute"
              right={8}
              bottom={8}
              // The view below must not see this press: its release would be a tap and seek.
              onPointerDown={(e) => {
                e.stopPropagation();
              }}
              onPointerUp={(e) => {
                e.stopPropagation();
              }}
              onPointerCancel={(e) => {
                e.stopPropagation();
              }}
              onClick={() => {
                setFollowOn(true);
                const v = viewRef.current;
                if (v) setView(follow(v, getPosition()));
              }}
            >
              {t("timeline.recenter")}
            </Button>
          )}
        </Box>
      </Box>
      <ZoomControls
        lanes={
          onLaneHeight && {
            shorter:
              laneHeight > minLaneHeight
                ? () => {
                    onLaneHeight(zoomLaneHeight(laneHeight, 1 / LANE_STEP, minLaneHeight));
                  }
                : null,
            taller:
              laneHeight < MAX_LANE_H
                ? () => {
                    onLaneHeight(zoomLaneHeight(laneHeight, LANE_STEP, minLaneHeight));
                  }
                : null,
          }
        }
        onZoom={zoom}
        onZoomToRange={zoomRange ? zoomToRange : null}
        onFit={() => {
          if (viewRef.current) setView(fitAll(durationSec, viewRef.current.widthPx));
        }}
      />
    </Box>
  );
}
