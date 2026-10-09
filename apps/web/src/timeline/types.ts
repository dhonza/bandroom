import type { TempoGrid } from "@bandroom/shared";
import type { ReactNode } from "react";
import type { Lane } from "./render";
import type { View } from "./view";

export interface TimeRange {
  start: number;
  end: number;
}

/** Colored band on the overview strip (sections) or a vertical guide (markers). */
export interface TimelineMark {
  start: number;
  end?: number;
  color: string;
}

export interface TimelineProps {
  lanes: Lane[];
  durationSec: number;
  /** Current playback position in seconds (read every frame, not React state). */
  getPosition: () => number;
  playing: boolean;
  onSeek: (sec: number) => void;
  laneHeight?: number;
  /**
   * Vertical zoom (SPEC §25.9): sets a new lane height (28–240 px) from the +/- buttons,
   * Alt/Option+wheel or a vertical two-finger pinch. Without it the height is fixed.
   */
  onLaneHeight?: (height: number) => void;
  /** The lowest lane height the zoom reaches (default 28 px; 44 in the touch Mixer). */
  minLaneHeight?: number;
  /**
   * Hides the waveform lanes (Mixer closed, SPEC §11.3): the overview strip, then the ruler and
   * the top lanes (sections, markers, comments) only.
   */
  hideLanes?: boolean;
  /** Height of the overview strip (default 36 px; the Player follows the vertical zoom, §25.9). */
  overviewHeight?: number;
  /** A row between the overview strip and the detail view (the Mixer tools). */
  belowOverview?: ReactNode;
  /** Track headers left of the lanes (Mixer open, SPEC §11.3), one per lane. */
  renderHeader?: (index: number) => ReactNode;
  headerWidth?: number;
  /** DOM lanes between the ruler and the waveforms (sections, markers; SPEC §11.3). */
  topLanesHeight?: number;
  /** Labels beside the top lanes, in the track-header column or, Mixer closed, the label column. */
  renderTopHeader?: () => ReactNode;
  /**
   * Width of the narrow label column holding the top-lane labels while `hideLanes` (Mixer closed,
   * SPEC §11.3). Shown only when some top lane is shown or there is a corner; default 0 (no
   * column).
   */
  labelWidth?: number;
  /**
   * The corner left of the overview strip, above the header or label column (the lanes menu).
   * The overview is indented by that column, so it shares the detail view's time axis.
   */
  renderCorner?: () => ReactNode;
  /** Absolutely positioned content over the detail view, laid out from the current view. */
  renderOverlay?: (view: View) => ReactNode;
  /** Section bands on the overview strip and marker guides across the lanes. */
  bands?: TimelineMark[];
  guides?: TimelineMark[];
  /** What "zoom to loop" (button, `Z`) shows: the loop, else the selection (SPEC §25.8). */
  zoomRange?: TimeRange | null;
  /** Loop (or selection) shown on the overview strip. */
  overviewRange?: TimeRange | null;
  overviewRangeColor?: string;
  /**
   * Range selection by dragging (SPEC §7.6): the ruler on every device, the waveform area with a
   * mouse, or long-press then drag on touch. The caller applies snapping.
   */
  onSelectDrag?: (anchorSec: number, sec: number, phase: "move" | "end", view: View) => void;
  /**
   * Long-press without moving (touch) or a right click (mouse): context menu at `sec` (SPEC §7.4),
   * with the overlay item under the pointer (`data-timeline-item`), if any (SPEC §25.7).
   */
  onLongPress?: (sec: number, clientX: number, clientY: number, item: string | null) => void;
  /** Tap on an overlay item (`data-timeline-item="<id>"`) instead of a seek; `sec`: where. */
  onItemTap?: (id: string, sec: number) => void;
  /** Tempo grid: bar/beat lines and a bars.beats ruler instead of m:ss (SPEC §11.3, §11.6). */
  grid?: TempoGrid | null;
}

/** Height of the detail view's ruler (CSS px). */
export const RULER_H = 28;
/** Default height of the overview strip (CSS px). */
export const OVERVIEW_H = 36;

/**
 * Vertical layout of the detail view: the ruler, the top lanes, then the waveform lanes (none
 * when hidden; at least one row otherwise, so an empty song still has a lane).
 */
export function detailLayout(f: {
  laneCount: number;
  laneHeight: number;
  topLanesHeight: number;
  hideLanes: boolean;
}): { lanesTop: number; shownLanes: number; height: number } {
  const lanesTop = RULER_H + f.topLanesHeight;
  const shownLanes = f.hideLanes ? 0 : Math.max(1, f.laneCount);
  return { lanesTop, shownLanes, height: lanesTop + shownLanes * f.laneHeight };
}
/** A pointer that moves less than this (CSS px) is a tap, not a drag. */
export const TAP_SLOP = 6;
/** While paused, how often the playhead is checked for a seek from elsewhere (keys, markers). */
export const PAUSED_POLL_MS = 100;
