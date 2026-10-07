import { create } from "zustand";
import { DEFAULT_FILTERS, type CommentFilters, type CommentSort } from "./model";

/** What a new comment is about; the time is captured when the button is pressed (SPEC §8). */
export interface ComposerDraft {
  startSec: number | null;
  /** Set when a selection was active: the comment defaults to that range. */
  range: { start: number; end: number } | null;
  useRange: boolean;
  trackId: string | null;
}

export interface CommentsUiState {
  songId: string | null;
  panelOpen: boolean;
  highlighted: string | null;
  filters: CommentFilters;
  sort: CommentSort;
  composer: ComposerDraft | null;
}

export const useCommentsUi = create<CommentsUiState>(() => ({
  songId: null,
  panelOpen: false,
  highlighted: null,
  filters: DEFAULT_FILTERS,
  sort: "time",
  composer: null,
}));

/** A new song page starts with a closed panel and no draft. */
export function openCommentsFor(songId: string): void {
  if (useCommentsUi.getState().songId === songId) return;
  useCommentsUi.setState({
    songId,
    panelOpen: false,
    highlighted: null,
    filters: DEFAULT_FILTERS,
    composer: null,
  });
}

export function setPanelOpen(panelOpen: boolean): void {
  useCommentsUi.setState({ panelOpen });
}

export function highlightComment(id: string | null, open = true): void {
  useCommentsUi.setState((s) => ({ highlighted: id, panelOpen: open || s.panelOpen }));
}

export function setFilters(patch: Partial<CommentFilters>): void {
  useCommentsUi.setState((s) => ({ filters: { ...s.filters, ...patch } }));
}

export function setSort(sort: CommentSort): void {
  useCommentsUi.setState({ sort });
}

/** Opens the composer in the panel with the time captured now. */
export function startComposer(draft: Omit<ComposerDraft, "useRange">): void {
  useCommentsUi.setState({
    panelOpen: true,
    composer: { ...draft, useRange: draft.range !== null },
  });
}

export function updateComposer(patch: Partial<ComposerDraft>): void {
  useCommentsUi.setState((s) => (s.composer ? { composer: { ...s.composer, ...patch } } : {}));
}

export function closeComposer(): void {
  useCommentsUi.setState({ composer: null });
}

/** For tests. */
export function resetCommentsUiForTests(): void {
  useCommentsUi.setState({
    songId: null,
    panelOpen: false,
    highlighted: null,
    filters: DEFAULT_FILTERS,
    sort: "time",
    composer: null,
  });
}
