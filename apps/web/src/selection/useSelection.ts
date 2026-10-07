import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { selectionOf, type Selection, type SelectionStore } from "./store";

/**
 * The selection of one list (SPEC §26.1). Leaving the screen (unmount) or switching to another
 * list ends selection mode; ids no longer in `available` are dropped.
 */
export function useSelection(
  store: SelectionStore,
  scope: string,
  available?: readonly string[],
): Selection {
  const state = store(
    useShallow((s) => ({
      scope: s.scope,
      active: s.active,
      ids: s.ids,
      start: s.start,
      toggle: s.toggle,
      setAll: s.setAll,
      exit: s.exit,
    })),
  );
  useEffect(
    () => () => {
      if (store.getState().scope === scope) store.getState().exit();
    },
    [store, scope],
  );
  const key = available?.join(",");
  useEffect(() => {
    if (available === undefined) return;
    const s = store.getState();
    if (!s.active || s.scope !== scope) return;
    const keep = s.ids.filter((id) => available.includes(id));
    if (keep.length !== s.ids.length) s.setAll(scope, keep);
    // `key` stands for `available`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, scope, key]);
  return useMemo(() => selectionOf(state, scope), [state, scope]);
}
