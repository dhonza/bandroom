import type { Marker, MarkerAnchor } from "@bandroom/shared";
import { create } from "zustand";
import { currentGrid } from "../tempo/store";
import {
  boundaries,
  isLoopable,
  loopTarget,
  musicalSnap,
  nextBoundary,
  nextSnapMode,
  nudge,
  prevBoundary,
  returnTarget,
  sameRange,
  SNAP_MODES,
  type Range,
  type SnapMode,
} from "./model";

/**
 * Song-page timeline state (SPEC §7.4–§7.6): selection, loop, snap mode, the marker editor, and
 * navigation actions against the song page's player.
 * The loop always equals the selection while it is on, so dragging the selection moves the loop.
 */

/** The song page's player (the engine, SPEC §27.4). */
export interface PlayerAdapter {
  position(): number;
  duration(): number;
  seek(sec: number): void;
  /** Applies (or clears) the loop (frame-accurate). */
  setLoop(range: Range | null): void;
  togglePlay(): void;
  isPlaying(): boolean;
}

export type EditorState =
  | { mode: "create"; type: "section" | "marker"; range: Range }
  | { mode: "edit"; id: string }
  | null;

export interface TimelineUiState {
  songId: string | null;
  markers: Marker[];
  selection: Range | null;
  loopOn: boolean;
  snap: SnapMode;
  /** Marker or section picked on the timeline (drag handles, selection bar). */
  picked: string | null;
  editor: EditorState;
  helpOpen: boolean;
  lastPlayStart: number | null;
  /** A selection or item drag is in progress: the loop is applied when it ends. */
  dragging: boolean;
}

const SNAP_KEY = "bandroom.snapMode";

function loadSnap(): SnapMode {
  try {
    const v = localStorage.getItem(SNAP_KEY);
    return SNAP_MODES.find((m) => m === v) ?? "markers";
  } catch {
    return "markers";
  }
}

export const useTimelineUi = create<TimelineUiState>(() => ({
  songId: null,
  markers: [],
  selection: null,
  loopOn: false,
  snap: loadSnap(),
  picked: null,
  editor: null,
  helpOpen: false,
  lastPlayStart: null,
  dragging: false,
}));

let player: PlayerAdapter | null = null;
let appliedLoop: Range | null = null;
let lastReturnAt = 0;

export function effectiveLoop(s: TimelineUiState = useTimelineUi.getState()): Range | null {
  return s.loopOn && isLoopable(s.selection) ? s.selection : null;
}

function applyLoop(force = false) {
  if (useTimelineUi.getState().dragging && !force) return;
  const loop = effectiveLoop();
  if (!force && sameRange(loop, appliedLoop)) return;
  appliedLoop = loop;
  player?.setLoop(loop);
}

useTimelineUi.subscribe(() => {
  applyLoop();
});

/** The song page opened (or changed song): a new song starts without selection or loop. */
export function openTimeline(songId: string): void {
  if (useTimelineUi.getState().songId === songId) return;
  useTimelineUi.setState({
    songId,
    markers: [],
    selection: null,
    loopOn: false,
    picked: null,
    editor: null,
    lastPlayStart: null,
  });
}

export function setMarkers(markers: Marker[]): void {
  const s = useTimelineUi.getState();
  const picked = s.picked && markers.some((m) => m.id === s.picked) ? s.picked : null;
  useTimelineUi.setState({ markers, picked });
}

/** Registers the active player; the current loop is applied to it. */
export function registerPlayer(p: PlayerAdapter): () => void {
  player = p;
  applyLoop(true);
  return () => {
    if (player === p) player = null;
  };
}

export function activePlayer(): PlayerAdapter | null {
  return player;
}

export function positionNow(): number {
  return player?.position() ?? 0;
}

export function seekTo(sec: number): void {
  player?.seek(Math.max(0, sec));
}

export function setSelection(selection: Range | null, picked: string | null = null): void {
  useTimelineUi.setState((s) => ({
    selection,
    picked,
    loopOn: selection ? s.loopOn : false,
  }));
}

export function setDragging(dragging: boolean): void {
  useTimelineUi.setState({ dragging });
}

export function clearSelection(): void {
  setSelection(null);
}

/** Loop toggle (`L`): loops the selection or the section under the playhead (SPEC §7.6). */
export function toggleLoop(): boolean {
  const s = useTimelineUi.getState();
  if (s.loopOn) {
    useTimelineUi.setState({ loopOn: false });
    return true;
  }
  const pos = positionNow();
  const target = loopTarget(s.selection, s.markers, pos);
  if (!target) return false;
  const picked = sameRange(target, s.selection) ? s.picked : null;
  useTimelineUi.setState({ selection: target, loopOn: true, picked });
  if (pos < target.start || pos >= target.end) seekTo(target.start);
  return true;
}

/** Whether `L` would do something (the button is disabled otherwise). */
export function canToggleLoop(s: TimelineUiState, position: number): boolean {
  return s.loopOn || loopTarget(s.selection, s.markers, position) !== null;
}

/** Selects a section (tap on its label). */
export function selectSection(m: Marker): void {
  if (m.endSec === null) return;
  setSelection({ start: m.startSec, end: m.endSec }, m.id);
}

/**
 * Loops a section (double tap on its label or chip): selects it, turns the loop on and jumps to
 * its start when the playhead is outside it. The most common rehearsal action (two taps).
 */
export function loopSection(m: Marker): void {
  if (m.endSec === null) return;
  loopRange({ start: m.startSec, end: m.endSec }, m.id);
}

/** Selects and loops a range, jumping to its start when the playhead is outside it. */
export function loopRange(range: Range, picked: string | null = null): void {
  if (!isLoopable(range)) return;
  useTimelineUi.setState({ selection: range, picked, loopOn: true });
  const pos = positionNow();
  if (pos < range.start || pos >= range.end) seekTo(range.start);
}

export function pickMarker(m: Marker): void {
  useTimelineUi.setState({ picked: m.id });
}

export function unpick(): void {
  useTimelineUi.setState({ picked: null });
}

export function setSnap(snap: SnapMode): void {
  try {
    localStorage.setItem(SNAP_KEY, snap);
  } catch {
    // private mode: keep it for this session only
  }
  useTimelineUi.setState({ snap });
}

export function cycleSnap(): SnapMode {
  const next = nextSnapMode(useTimelineUi.getState().snap, currentGrid() !== null);
  setSnap(next);
  return next;
}

/** Play/pause through the active player, remembering where playback started (`Enter`). */
export function playPause(): void {
  const p = player;
  if (!p) return;
  if (!p.isPlaying()) useTimelineUi.setState({ lastPlayStart: p.position() });
  p.togglePlay();
}

export function notePlayStart(sec: number): void {
  useTimelineUi.setState({ lastPlayStart: sec });
}

export function returnToStart(): void {
  const now = Date.now();
  const second = now - lastReturnAt < 1500;
  lastReturnAt = now;
  const s = useTimelineUi.getState();
  seekTo(returnTarget(effectiveLoop(s), s.lastPlayStart, second));
}

export function goPrev(): void {
  const s = useTimelineUi.getState();
  const tolerance = player?.isPlaying() ? 0.5 : 0.05;
  seekTo(prevBoundary(boundaries(s.markers), positionNow(), tolerance));
}

export function goNext(): void {
  const s = useTimelineUi.getState();
  const next = nextBoundary(boundaries(s.markers), positionNow());
  if (next !== null) seekTo(next);
}

export function nudgeBy(dir: -1 | 1, big: boolean): void {
  seekTo(nudge(positionNow(), dir, big, player?.duration() ?? 0, currentGrid()));
}

/**
 * Anchor for an item created or moved now (SPEC §7.4): musical while snapping to a musical grid
 * (with a tempo map); otherwise new items are time-anchored and edited ones keep theirs.
 */
export function anchorNow(existing?: MarkerAnchor): MarkerAnchor {
  if (musicalSnap(useTimelineUi.getState().snap) && currentGrid()) return "musical";
  return existing ?? "time";
}

export function openEditor(editor: EditorState): void {
  useTimelineUi.setState({ editor });
}

export function closeEditor(): void {
  useTimelineUi.setState({ editor: null });
}

export function setHelpOpen(helpOpen: boolean): void {
  useTimelineUi.setState({ helpOpen });
}

/** For tests. */
export function resetTimelineUiForTests(): void {
  player = null;
  appliedLoop = null;
  lastReturnAt = 0;
  useTimelineUi.setState({
    songId: null,
    markers: [],
    selection: null,
    loopOn: false,
    picked: null,
    editor: null,
    helpOpen: false,
    lastPlayStart: null,
    dragging: false,
  });
}
