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

interface ChromeState {
  /** "Hide navigation", remembered. */
  hidden: boolean;
  /**
   * Hidden automatically (SPEC §31.6: the song page in a phone's landscape viewport); not
   * remembered, and gone again in portrait or on another page.
   */
  auto: boolean;
  /** "Show navigation" while auto-hidden: shown until the automatic state ends. */
  autoDismissed: boolean;
}

export const useChrome = create<ChromeState>(() => ({
  hidden: load(),
  auto: false,
  autoDismissed: false,
}));

/** The header and navigation are collapsed (by the user or automatically). */
export function chromeCollapsed(s: ChromeState): boolean {
  return s.hidden || (s.auto && !s.autoDismissed);
}

/** Only automatically hidden: no floating restore button (the page offers "Show navigation"). */
export function chromeAutoOnly(s: ChromeState): boolean {
  return !s.hidden && s.auto && !s.autoDismissed;
}

export function setChromeAuto(auto: boolean): void {
  const s = useChrome.getState();
  if (s.auto === auto) return;
  useChrome.setState({ auto, autoDismissed: false });
}

/** "Show navigation" from the page: ends the manual and the automatic hiding. */
export function showChrome(): void {
  setChromeHidden(false);
  if (useChrome.getState().auto) useChrome.setState({ autoDismissed: true });
}

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
