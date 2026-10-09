import { useEffect } from "react";
import { useEditActions } from "./actions";
import { resolveEditKey } from "./model";
import { clearPick, useEdit } from "./store";

/** Typing, a dialog or a menu keeps its keys (as with the song page's shortcuts). */
function ignored(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return (
    el?.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]") !=
    null
  );
}

/**
 * Edit mode keys (SPEC §24.6), ahead of the song page's shortcuts (capture phase): `X` split,
 * `Delete`/`Backspace` cut, `Shift+Delete` silence, `G` gain, `Cmd/Ctrl+Z` undo,
 * `Cmd/Ctrl+Shift+Z` and `Ctrl+Y` redo; `Esc` clears the picked regions first (then the page's
 * `Esc` clears the selection).
 */
export function useEditShortcuts(active: boolean): void {
  const actions = useEditActions();
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || ignored(e)) return;
      const action = resolveEditKey(e);
      if (!action) return;
      if (e.repeat && action !== "undo" && action !== "redo") return;
      // A drag in progress: `Esc` aborts it (the clip overlay), nothing else runs meanwhile.
      if (useEdit.getState().dragging) return;
      switch (action) {
        case "split":
          actions.split();
          break;
        case "cut":
          actions.range("cut");
          break;
        case "silence":
          actions.range("silence");
          break;
        case "gain":
          actions.openGain();
          break;
        case "undo":
          actions.undo();
          break;
        case "redo":
          actions.redo();
          break;
        case "escape":
          if (!clearPick()) return; // the page clears the selection
          break;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [active, actions]);
}
