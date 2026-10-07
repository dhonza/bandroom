import { create } from "zustand";
import type { KeyLike } from "../markers/keymap";

/**
 * "Hide navigation" (SPEC §25.2): the header and the navbar or tab bar make room for the page.
 * Remembered per device; browser storage may be unavailable (private mode), so it then lasts for
 * the page only.
 */
const CHROME_KEY = "bandroom.chromeHidden";

function load(): boolean {
  try {
    return localStorage.getItem(CHROME_KEY) === "1";
  } catch {
    return false;
  }
}

function save(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(CHROME_KEY, "1");
    else localStorage.removeItem(CHROME_KEY);
  } catch {
    // per-device convenience only
  }
}

export const useChrome = create<{ hidden: boolean }>(() => ({ hidden: load() }));

export function setChromeHidden(hidden: boolean): void {
  save(hidden);
  useChrome.setState({ hidden });
}

export function toggleChrome(): void {
  setChromeHidden(!useChrome.getState().hidden);
}

/** `Shift+F` toggles the navigation on every screen. */
export function isChromeToggleKey(e: KeyLike): boolean {
  return e.code === "KeyF" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
}

/** Keys typed into fields or dialogs are not shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  return (
    el?.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]") !=
    null
  );
}
