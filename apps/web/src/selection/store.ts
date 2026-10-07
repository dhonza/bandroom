import { create, type StoreApi, type UseBoundStore } from "zustand";

/**
 * Multi-select state of one screen (SPEC §26.1). `scope` is the list it belongs to (project,
 * song, track…), so a selection never leaks into another list of the same kind.
 */
export interface SelectionState {
  scope: string | null;
  active: boolean;
  ids: readonly string[];
  /** Enters selection mode, optionally with a first item (long-press, checkbox). */
  start: (scope: string, id?: string) => void;
  toggle: (scope: string, id: string) => void;
  setAll: (scope: string, ids: readonly string[]) => void;
  exit: () => void;
}

export type SelectionStore = UseBoundStore<StoreApi<SelectionState>>;

export function createSelectionStore(): SelectionStore {
  return create<SelectionState>((set, get) => ({
    scope: null,
    active: false,
    ids: [],
    start: (scope, id) => {
      set({ scope, active: true, ids: id === undefined ? [] : [id] });
    },
    toggle: (scope, id) => {
      const s = get();
      if (!s.active || s.scope !== scope) {
        set({ scope, active: true, ids: [id] });
        return;
      }
      set({ ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id] });
    },
    setAll: (scope, ids) => {
      set({ scope, active: true, ids: [...ids] });
    },
    exit: () => {
      set({ scope: null, active: false, ids: [] });
    },
  }));
}

/** One store per screen kind (SPEC §26.1): songs of a project, tracks of a song, versions… */
export const songSelection = createSelectionStore();
export const trackSelection = createSelectionStore();
export const versionSelection = createSelectionStore();
export const trashSelection = createSelectionStore();

export interface Selection {
  active: boolean;
  ids: ReadonlySet<string>;
  start: (id?: string) => void;
  toggle: (id: string) => void;
  setAll: (ids: readonly string[]) => void;
  exit: () => void;
}

/** The store's state for one list; another scope's selection reads as inactive. */
export function selectionOf(state: SelectionState, scope: string): Selection {
  const mine = state.active && state.scope === scope;
  return {
    active: mine,
    ids: new Set(mine ? state.ids : []),
    start: (id) => {
      state.start(scope, id);
    },
    toggle: (id) => {
      state.toggle(scope, id);
    },
    setAll: (ids) => {
      state.setAll(scope, ids);
    },
    exit: state.exit,
  };
}
