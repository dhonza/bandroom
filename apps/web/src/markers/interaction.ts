import type { Marker } from "@bandroom/shared";
import { swallowNextClick } from "../lib/gestures";
import type { View } from "../timeline/view";
import { currentGrid } from "../tempo/store";
import { boundaries, effectiveSnap, isDoubleTap, snapWith, SNAP_PX } from "./model";
import { openEditor, pickMarker, seekTo, selectSection, useTimelineUi } from "./store";

/**
 * Snaps to other items' edges and, in a musical mode, to the tempo grid within 12 px at the
 * current zoom (SPEC §7.5); Alt bypasses.
 */
export function makeSnapper(view: View, markers: readonly Marker[], excludeId?: string) {
  const targets = boundaries(markers.filter((m) => m.id !== excludeId));
  const threshold = SNAP_PX / view.pxPerSec;
  const grid = currentGrid();
  const mode = effectiveSnap(useTimelineUi.getState().snap, grid !== null);
  return (sec: number, bypass: boolean) =>
    bypass ? sec : snapWith(sec, mode, targets, threshold, grid);
}

let lastTap: { id: string; at: number } | null = null;

/**
 * Tap on a section label selects it; a marker tap picks it and jumps there. A second tap within
 * 400 ms (a double click or double tap) opens the item's editor when the user may edit it (SPEC
 * §25.7); otherwise it is just another tap. Sections loop from the selection bar or `L`.
 */
export function tapItem(m: Marker, editable: boolean): void {
  const now = Date.now();
  const double = isDoubleTap(lastTap, m.id, now);
  lastTap = double ? null : { id: m.id, at: now };
  if (double && editable) {
    // The tap's click would otherwise land on the editor that opens under the finger.
    swallowNextClick();
    openEditor({ mode: "edit", id: m.id });
    return;
  }
  if (m.type === "section") selectSection(m);
  else {
    pickMarker(m);
    seekTo(m.startSec);
  }
}

/** For tests. */
export function resetTapForTests(): void {
  lastTap = null;
}
