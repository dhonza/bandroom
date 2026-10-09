import {
  applyOp,
  canRedo,
  canUndo,
  DEFAULT_EDIT_FADES,
  FOLLOW_ALL,
  initialState,
  pushOp,
  redo as redoHistory,
  replay,
  undo as undoHistory,
  validateOp,
  type EditBase,
  type EditOp,
  type EditOptions,
  type EditRefusal,
  type EditState,
  type TrackVersion,
} from "@bandroom/shared";
import { create } from "zustand";

/**
 * Edit mode state of the song page (SPEC §24.6–§24.7): the session's base, ops, cursor and
 * options; the derived clips; the track selection and the picked clips (not ops); the save
 * status. The page owner edits; the server holds the session (autosave, `session.ts`).
 */

export type SaveStatus = "saved" | "saving" | "unsaved" | "error";

export interface EditSessionRef {
  id: string;
  songId: string;
  /** Optimistic concurrency of saves (SPEC §24.7). */
  rev: number;
}

export interface EditStore {
  /** The song in edit mode on this page (null: not editing). */
  songId: string | null;
  session: EditSessionRef | null;
  base: EditBase | null;
  ops: EditOp[];
  cursor: number;
  options: EditOptions;
  /** `replay(base, ops, cursor)`. */
  state: EditState | null;
  /** The versions the clips play (by id): the base versions. */
  versions: Record<string, TrackVersion>;
  /** Track selection (SPEC §24.6): the tracks ops act on. */
  selectedTracks: string[];
  /** Picked clips (ids). */
  picked: string[];
  /** Touch: a long-press started picking; further taps add. */
  picking: boolean;
  save: SaveStatus;
  /** Changes not sent yet (ops, cursor or options). */
  dirty: boolean;
  /** Bumped by every change that the server should get. */
  changeSeq: number;
  /** A clip drag or trim is running (Esc aborts it). */
  dragging: boolean;
  /** The toolbar dialog that is open. */
  dialog: EditDialog | null;
  /**
   * `applying`: Apply or a Bounce is rendering (SPEC §24.8); the edit is read-only until the
   * commit (or a failure, which returns the session to `editing`).
   */
  phase: EditPhase;
}

export type EditPhase = "editing" | "applying";

export type EditDialog = "gain" | "splitAtMarkers" | "options" | "cancel" | "apply" | "bounce";

export const DEFAULT_EDIT_OPTIONS: EditOptions = {
  fades: DEFAULT_EDIT_FADES,
  overlap: "mix",
  timeline: FOLLOW_ALL,
  snap: "markers",
};

const idle = (): Omit<EditStore, "options"> => ({
  songId: null,
  session: null,
  base: null,
  ops: [],
  cursor: 0,
  state: null,
  versions: {},
  selectedTracks: [],
  picked: [],
  picking: false,
  save: "saved",
  dirty: false,
  changeSeq: 0,
  dragging: false,
  dialog: null,
  phase: "editing",
});

export const useEdit = create<EditStore>(() => ({ ...idle(), options: DEFAULT_EDIT_OPTIONS }));

export interface LoadedSession {
  session: EditSessionRef;
  base: EditBase;
  ops: EditOp[];
  cursor: number;
  options: EditOptions;
  versions: Record<string, TrackVersion>;
  /** `applying` while the server renders the edit (read-only); default `editing`. */
  phase?: EditPhase;
}

/**
 * Enters edit mode with a session (started, reloaded or taken over). The track selection is kept
 * when the same session comes back (a reload of its state); otherwise all tracks are selected.
 */
export function enterEdit(s: LoadedSession): void {
  const prev = useEdit.getState();
  const trackIds = s.base.tracks.map((t) => t.trackId);
  const same = prev.session?.id === s.session.id;
  const cursor = Math.min(s.cursor, s.ops.length);
  const state = replay(s.base, s.ops, cursor);
  const clipIds = new Set(state.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  useEdit.setState({
    songId: s.session.songId,
    session: s.session,
    base: s.base,
    ops: s.ops,
    cursor,
    options: s.options,
    state,
    versions: s.versions,
    selectedTracks: same ? prev.selectedTracks.filter((id) => trackIds.includes(id)) : trackIds,
    picked: same ? prev.picked.filter((id) => clipIds.has(id)) : [],
    picking: same && prev.picking,
    save: "saved",
    dirty: false,
    dragging: false,
    phase: s.phase ?? "editing",
  });
}

/** Leaves edit mode (cancel, apply, takeover by someone else, leaving the page). */
export function exitEdit(): void {
  useEdit.setState({ ...idle(), options: useEdit.getState().options });
}

export function isEditing(songId?: string): boolean {
  const s = useEdit.getState();
  return s.songId !== null && (songId === undefined || s.songId === songId);
}

/**
 * Adds an op (SPEC §24.3): refused with a reason when the model says so (never stored);
 * otherwise the redo tail goes and the clips are recomputed.
 */
export function runOp(op: EditOp): EditRefusal | null {
  const s = useEdit.getState();
  if (!s.state || !s.base || s.phase !== "editing") return "noChange";
  const refusal = validateOp(s.state, op);
  if (refusal) return refusal;
  const h = pushOp({ ops: s.ops, cursor: s.cursor }, op);
  const state = applyOp(s.state, op);
  const clipIds = new Set(state.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  useEdit.setState({
    ops: h.ops,
    cursor: h.cursor,
    state,
    picked: s.picked.filter((id) => clipIds.has(id)),
    ...changed(s),
  });
  return null;
}

function changed(s: EditStore): Pick<EditStore, "dirty" | "changeSeq" | "save"> {
  return { dirty: true, changeSeq: s.changeSeq + 1, save: "unsaved" };
}

function moveCursor(next: { ops: EditOp[]; cursor: number }): boolean {
  const s = useEdit.getState();
  if (!s.base || s.phase !== "editing" || next.cursor === s.cursor) return false;
  const state = replay(s.base, next.ops, next.cursor);
  const clipIds = new Set(state.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  useEdit.setState({
    cursor: next.cursor,
    state,
    picked: s.picked.filter((id) => clipIds.has(id)),
    ...changed(s),
  });
  return true;
}

export function undoEdit(): boolean {
  const s = useEdit.getState();
  return moveCursor(undoHistory({ ops: s.ops, cursor: s.cursor }));
}

export function redoEdit(): boolean {
  const s = useEdit.getState();
  return moveCursor(redoHistory({ ops: s.ops, cursor: s.cursor }));
}

export function editCanUndo(s: Pick<EditStore, "ops" | "cursor">): boolean {
  return canUndo(s);
}

export function editCanRedo(s: Pick<EditStore, "ops" | "cursor">): boolean {
  return canRedo(s);
}

/** Options apply to the next ops only (each op keeps its own copy, SPEC §24.2). */
export function setEditOptions(patch: Partial<EditOptions>): void {
  const s = useEdit.getState();
  if (s.phase !== "editing") return;
  const options = { ...s.options, ...patch };
  if (JSON.stringify(options) === JSON.stringify(s.options)) return;
  useEdit.setState({ options, ...(s.session ? changed(s) : {}) });
}

export function setSelectedTracks(ids: string[]): void {
  const s = useEdit.getState();
  const order = s.base?.tracks.map((t) => t.trackId) ?? ids;
  useEdit.setState({ selectedTracks: order.filter((id) => ids.includes(id)) });
}

export function toggleTrackSelected(id: string): void {
  const s = useEdit.getState();
  setSelectedTracks(
    s.selectedTracks.includes(id)
      ? s.selectedTracks.filter((x) => x !== id)
      : [...s.selectedTracks, id],
  );
}

/** Picks a clip: alone, or added (Shift/Cmd, or touch picking mode; a picked one is removed). */
export function pickClip(id: string, add: boolean): void {
  const s = useEdit.getState();
  if (s.phase !== "editing") return;
  if (!add) {
    useEdit.setState({ picked: [id] });
    return;
  }
  useEdit.setState({
    picked: s.picked.includes(id) ? s.picked.filter((x) => x !== id) : [...s.picked, id],
  });
}

/** Touch: a long-press picks the clip and starts picking (further taps add). */
export function startPicking(id: string): void {
  const s = useEdit.getState();
  if (s.phase !== "editing") return;
  useEdit.setState({ picking: true, picked: s.picked.includes(id) ? s.picked : [...s.picked, id] });
}

/** Clears the pick; false when nothing was picked (`Esc` then clears the selection). */
export function clearPick(): boolean {
  const s = useEdit.getState();
  if (s.picked.length === 0 && !s.picking) return false;
  useEdit.setState({ picked: [], picking: false });
  return true;
}

export function openEditDialog(dialog: EditDialog | null): void {
  useEdit.setState({ dialog });
}

/** Read-only while the server renders the edit (SPEC §24.8). */
export function setEditPhase(phase: EditPhase): void {
  const s = useEdit.getState();
  if (s.phase === phase) return;
  useEdit.setState(
    phase === "applying" ? { phase, picked: [], picking: false, dragging: false } : { phase },
  );
}

export function isEditReadOnly(s: Pick<EditStore, "phase">): boolean {
  return s.phase !== "editing";
}

export function setEditDragging(dragging: boolean): void {
  useEdit.setState({ dragging });
}

/** The server confirmed a save: the new rev; still dirty when something changed meanwhile. */
export function savedAt(rev: number, seq: number): void {
  const s = useEdit.getState();
  if (!s.session) return;
  const clean = s.changeSeq === seq;
  useEdit.setState({
    session: { ...s.session, rev },
    dirty: !clean,
    save: clean ? "saved" : "unsaved",
  });
}

export function setSaveStatus(save: SaveStatus): void {
  useEdit.setState({ save });
}

/** The clips before any op (for tests and the "edited" check). */
export function baseState(): EditState | null {
  const b = useEdit.getState().base;
  return b ? initialState(b) : null;
}

/** For tests. */
export function resetEditForTests(): void {
  useEdit.setState({ ...idle(), options: DEFAULT_EDIT_OPTIONS });
}
