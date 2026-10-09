import { type EditClip, type EditState, type Marker } from "@bandroom/shared";
import { Box, Text } from "@mantine/core";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { boundaries, effectiveSnap, snapWith, SNAP_PX } from "../markers/model";
import { seekSec } from "../rehearse/controller";
import { currentGrid } from "../tempo/store";
import { TAP_SLOP } from "../timeline/types";
import { secToX, xToSec, type View } from "../timeline/view";
import {
  clipBoxes,
  clipEdges,
  fadePath,
  framesToSec,
  HANDLE_PX,
  moveFromDrag,
  moveOp,
  trimFromDrag,
  trimOp,
  type ClipBox,
  type Snap,
} from "./model";
import { useRunOp } from "./useRunOp";
import { pickClip, setEditDragging, useEdit } from "./store";

const EDGES: readonly ("start" | "end")[] = ["start", "end"];

/** Prefix of clip ids in `data-timeline-item` (touch taps and long-presses go through the timeline). */
export const CLIP_ITEM_PREFIX = "clip:";

interface Lane {
  trackId: string;
  color: string;
}

type Drag =
  | {
      kind: "move";
      pointerId: number;
      x: number;
      y: number;
      moved: boolean;
      box: ClipBox;
      grabY: number;
      add: boolean;
    }
  | {
      kind: "trim";
      pointerId: number;
      x: number;
      moved: boolean;
      clip: EditClip;
      edge: "start" | "end";
    };

interface Draft {
  /** Moved clips at their new place (lane index, seconds). */
  ghosts: { id: string; lane: number; startSec: number; endSec: number }[];
  label: string;
  labelX: number;
  labelLane: number;
  snapSec: number | null;
}

/**
 * The clips of edit mode over the track lanes (SPEC §24.6): edges, fades, a gain badge; click
 * or tap picks (Shift/Cmd adds; on touch a long-press starts picking); dragging a clip's body
 * moves it in time and to another lane; picked clips get 44 px edge handles that trim. Snapping
 * follows the snap mode (Alt bypasses); `Esc` aborts a drag. The waveforms are drawn by the
 * timeline's canvas (`Lane.clips`).
 */
export function ClipOverlay({
  view,
  top,
  laneHeight,
  lanes,
  markers,
}: {
  view: View;
  /** Top of the first track lane in the detail view. */
  top: number;
  laneHeight: number;
  lanes: readonly Lane[];
  markers: readonly Marker[];
}) {
  const { t } = useTranslation();
  const state = useEdit((s) => s.state);
  const picked = useEdit((s) => s.picked);
  const picking = useEdit((s) => s.picking);
  const snapMode = useEdit((s) => s.options.snap);
  const runOp = useRunOp();
  const [draft, setDraft] = useState<Draft | null>(null);
  const drag = useRef<Drag | null>(null);
  const draftOp = useRef<(() => void) | null>(null);

  // The lanes' clips in lane order (the timeline's tracks); the model works on that order.
  const laneState = useMemo((): EditState | null => {
    if (!state) return null;
    return {
      ...state,
      tracks: lanes.map(
        (l) =>
          state.tracks.find((x) => x.trackId === l.trackId) ?? { trackId: l.trackId, clips: [] },
      ),
    };
  }, [state, lanes]);
  const boxes = useMemo(
    () => (laneState ? clipBoxes(view, laneState.tracks) : []),
    [laneState, view],
  );
  const pickedSet = useMemo(() => new Set(picked), [picked]);

  const abort = () => {
    drag.current = null;
    draftOp.current = null;
    setDraft(null);
    setEditDragging(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !drag.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      abort();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  if (!laneState) return null;

  const snapper = (except: ReadonlySet<string>, bypass: boolean): Snap | null => {
    const grid = currentGrid();
    const mode = effectiveSnap(snapMode, grid !== null);
    if (bypass || mode === "off") return null;
    const targets = [...boundaries(markers), ...clipEdges(laneState, except)];
    const threshold = SNAP_PX / view.pxPerSec;
    return (sec) => snapWith(sec, mode, targets, threshold, grid);
  };

  const laneY = (lane: number) => top + lane * laneHeight;
  const deltaLabel = (frames: number) => {
    const sec = framesToSec(frames);
    return t("edit.delta", { value: `${sec >= 0 ? "+" : "−"}${Math.abs(sec).toFixed(2)}` });
  };

  const onBodyDown = (e: ReactPointerEvent, box: ClipBox) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const isPicked = pickedSet.has(box.clip.id);
    // Touch on a clip that is not picked: the timeline scrolls, seeks (tap) or picks (long-press).
    if (e.pointerType === "touch" && !isPicked && !picking) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    drag.current = {
      kind: "move",
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      box,
      grabY: e.clientY - rect.top + 2,
      add: e.shiftKey || e.metaKey || e.ctrlKey || (e.pointerType === "touch" && picking),
    };
  };

  const onHandleDown = (e: ReactPointerEvent, clip: EditClip, edge: "start" | "end") => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: "trim", pointerId: e.pointerId, x: e.clientX, moved: false, clip, edge };
  };

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.x;
    if (!d.moved) {
      const dy = d.kind === "move" ? e.clientY - d.y : 0;
      if (Math.abs(dx) <= TAP_SLOP && Math.abs(dy) <= TAP_SLOP) return;
      d.moved = true;
      setEditDragging(true);
      if (d.kind === "move" && !pickedSet.has(d.box.clip.id)) pickClip(d.box.clip.id, d.add);
    }
    if (d.kind === "trim") {
      const r = trimFromDrag(d.clip, d.edge, dx, view, snapper(new Set([d.clip.id]), e.altKey));
      const lane = laneState.tracks.findIndex((x) => x.clips.some((c) => c.id === d.clip.id));
      const s = framesToSec(d.clip.startFrame);
      const end = s + framesToSec(d.clip.lengthFrames);
      const delta = framesToSec(r.deltaFrames);
      const ghost =
        d.edge === "start"
          ? { id: d.clip.id, lane, startSec: s + delta, endSec: end }
          : { id: d.clip.id, lane, startSec: s, endSec: end + delta };
      setDraft({
        ghosts: [ghost],
        label: deltaLabel(r.deltaFrames),
        labelX: secToX(view, d.edge === "start" ? ghost.startSec : ghost.endSec),
        labelLane: lane,
        snapSec: r.snappedSec,
      });
      const clipId = d.clip.id;
      const edge = d.edge;
      draftOp.current =
        r.deltaFrames === 0
          ? null
          : () => {
              runOp((o) => trimOp(o, clipId, edge, r.deltaFrames));
            };
      return;
    }
    const ids = pickedSet.has(d.box.clip.id) ? picked : [d.box.clip.id];
    const moving = d.add && !pickedSet.has(d.box.clip.id) ? [...picked, d.box.clip.id] : ids;
    const r = moveFromDrag(
      { clipIds: moving, grabbed: d.box.clip, fromTrack: d.box.trackIndex, grabY: d.grabY },
      laneState,
      dx,
      e.clientY - d.y,
      view,
      laneHeight,
      snapper(new Set(moving), e.altKey),
    );
    const delta = framesToSec(r.deltaFrames);
    const ghosts = laneState.tracks.flatMap((tr, lane) =>
      tr.clips
        .filter((c) => moving.includes(c.id))
        .map((c) => ({
          id: c.id,
          lane: r.toTrack ?? lane,
          startSec: framesToSec(c.startFrame) + delta,
          endSec: framesToSec(c.startFrame + c.lengthFrames) + delta,
        })),
    );
    setDraft({
      ghosts,
      label: deltaLabel(r.deltaFrames),
      labelX: secToX(view, framesToSec(d.box.clip.startFrame) + delta),
      labelLane: r.toTrack ?? d.box.trackIndex,
      snapSec: r.snappedSec,
    });
    const toTrackId = r.toTrack === null ? null : (lanes[r.toTrack]?.trackId ?? null);
    draftOp.current =
      r.deltaFrames === 0 && toTrackId === null
        ? null
        : () => {
            runOp((o) => moveOp(o, moving, r.deltaFrames, toTrackId));
          };
  };

  const onUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    const commit = draftOp.current;
    abort();
    if (e.type === "pointercancel") return;
    if (d.moved) {
      commit?.();
      return;
    }
    if (d.kind === "move") {
      pickClip(d.box.clip.id, d.add);
      // A click also moves the playhead there (a split at the playhead is one key away).
      if (e.pointerType !== "touch") {
        const rect = (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect();
        if (rect) seekSec(Math.max(0, xToSec(view, e.clientX - rect.left)));
      }
    }
  };

  const handlers = { onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp };
  const handleList = boxes
    .filter((b) => pickedSet.has(b.clip.id))
    .flatMap((b) =>
      EDGES.filter((edge) => (edge === "start" ? b.startVisible : b.endVisible)).map((edge) => ({
        b,
        edge,
      })),
    );
  const ghostIds = new Set(draft?.ghosts.map((g) => g.id));

  return (
    <Box pos="absolute" style={{ inset: 0 }} data-testid="edit-clips">
      {boxes.map((b) => {
        const lane = lanes[b.trackIndex];
        if (!lane) return null;
        const isPicked = pickedSet.has(b.clip.id);
        const color = lane.color;
        const fadeIn = framesToSec(b.clip.fadeInFrames) * view.pxPerSec;
        const fadeOut = framesToSec(b.clip.fadeOutFrames) * view.pxPerSec;
        const h = laneHeight - 4;
        const gain = Math.round(b.clip.gainDb * 10) / 10;
        return (
          <Box
            key={b.clip.id}
            {...handlers}
            onPointerDown={(e) => {
              onBodyDown(e, b);
            }}
            data-timeline-item={`${CLIP_ITEM_PREFIX}${b.clip.id}`}
            data-testid="edit-clip"
            data-clip-id={b.clip.id}
            data-track-id={lane.trackId}
            data-picked={isPicked || undefined}
            aria-label={t("edit.clipLabel", {
              start: framesToSec(b.clip.startFrame).toFixed(2),
              end: framesToSec(b.clip.startFrame + b.clip.lengthFrames).toFixed(2),
            })}
            role="button"
            aria-pressed={isPicked}
            style={{
              position: "absolute",
              left: b.left,
              top: laneY(b.trackIndex) + 2,
              width: b.width,
              height: h,
              pointerEvents: "auto",
              cursor: isPicked ? "grab" : "pointer",
              touchAction: isPicked || picking ? "none" : "pan-y",
              borderRadius: 3,
              border: `${isPicked ? 2 : 1}px solid var(--mantine-color-${color}-${isPicked ? 3 : 6})`,
              background: isPicked
                ? `color-mix(in srgb, var(--mantine-color-${color}-5) 22%, transparent)`
                : undefined,
              opacity: ghostIds.has(b.clip.id) ? 0.45 : 1,
              boxSizing: "border-box",
              overflow: "hidden",
            }}
          >
            {(fadeIn >= 2 || fadeOut >= 2) && (
              <svg
                width={b.width}
                height={h}
                style={{
                  position: "absolute",
                  inset: 0,
                  pointerEvents: "none",
                  overflow: "visible",
                }}
                aria-hidden
              >
                {fadeIn >= 2 && (
                  <path
                    d={fadePath(fadeIn, h - 4, b.clip.fadeInShape, "in")}
                    transform={`translate(${b.x0 - b.left},2)`}
                    fill="none"
                    stroke="var(--mantine-color-text)"
                    strokeOpacity={0.7}
                    strokeWidth={1.5}
                    data-testid="clip-fade-in"
                  />
                )}
                {fadeOut >= 2 && (
                  <path
                    d={fadePath(fadeOut, h - 4, b.clip.fadeOutShape, "out")}
                    transform={`translate(${b.x1 - b.left - fadeOut},2)`}
                    fill="none"
                    stroke="var(--mantine-color-text)"
                    strokeOpacity={0.7}
                    strokeWidth={1.5}
                    data-testid="clip-fade-out"
                  />
                )}
              </svg>
            )}
            {gain !== 0 && b.width > 36 && (
              <Text
                size="xs"
                fw={600}
                px={4}
                style={{
                  position: "absolute",
                  top: 2,
                  left: Math.max(2, b.x0 - b.left + 2),
                  borderRadius: 3,
                  background: "var(--mantine-color-body)",
                  opacity: 0.85,
                  pointerEvents: "none",
                }}
                data-testid="clip-gain"
              >
                {t("edit.gainBadge", { value: gain > 0 ? `+${gain}` : String(gain) })}
              </Text>
            )}
          </Box>
        );
      })}
      {handleList.map(({ b, edge }) => (
        <Box
          key={`${b.clip.id}:${edge}`}
          {...handlers}
          onPointerDown={(e) => {
            onHandleDown(e, b.clip, edge);
          }}
          role="slider"
          aria-label={t(edge === "start" ? "edit.trimStart" : "edit.trimEnd")}
          aria-valuenow={
            Math.round(
              framesToSec(
                edge === "start" ? b.clip.startFrame : b.clip.startFrame + b.clip.lengthFrames,
              ) * 100,
            ) / 100
          }
          data-testid="clip-handle"
          data-edge={edge}
          style={{
            position: "absolute",
            left: (edge === "start" ? b.x0 : b.x1) - HANDLE_PX / 2,
            top: laneY(b.trackIndex) + Math.max(0, (laneHeight - Math.max(44, laneHeight - 4)) / 2),
            width: HANDLE_PX,
            height: Math.max(44, laneHeight - 4),
            pointerEvents: "auto",
            cursor: "ew-resize",
            touchAction: "none",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 2,
          }}
        >
          <Box
            w={6}
            h="60%"
            style={{
              borderRadius: 3,
              background: `var(--mantine-color-${lanes[b.trackIndex]?.color ?? "gray"}-3)`,
              boxShadow: "0 0 0 1px var(--mantine-color-body)",
            }}
          />
        </Box>
      ))}
      {draft?.ghosts.map((g) => (
        <Box
          key={`ghost:${g.id}`}
          data-testid="edit-ghost"
          style={{
            position: "absolute",
            left: secToX(view, g.startSec),
            width: Math.max(1, (g.endSec - g.startSec) * view.pxPerSec),
            top: laneY(g.lane) + 2,
            height: laneHeight - 4,
            border: "2px dashed var(--mantine-color-text)",
            borderRadius: 3,
            pointerEvents: "none",
            zIndex: 3,
          }}
        />
      ))}
      {draft?.snapSec !== null && draft?.snapSec !== undefined && (
        <Box
          data-testid="edit-snap-line"
          style={{
            position: "absolute",
            left: secToX(view, draft.snapSec) - 1,
            top: 0,
            bottom: 0,
            width: 2,
            background: "var(--mantine-color-yellow-4)",
            pointerEvents: "none",
            zIndex: 3,
          }}
        />
      )}
      {draft && (
        <Text
          size="xs"
          fw={700}
          px={6}
          data-testid="edit-drag-delta"
          style={{
            position: "absolute",
            left: Math.min(Math.max(0, draft.labelX + 4), view.widthPx - 72),
            top: laneY(draft.labelLane) + 4,
            background: "var(--mantine-color-body)",
            borderRadius: 4,
            pointerEvents: "none",
            zIndex: 4,
          }}
        >
          {draft.label}
        </Text>
      )}
    </Box>
  );
}
