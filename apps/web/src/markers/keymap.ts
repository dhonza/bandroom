/**
 * Keyboard shortcuts and pedal mapping (SPEC §11.4). Defaults follow the SPEC table; a per-device
 * mapping (Settings → Keyboard) lets page-turner pedals trigger any mappable action and takes
 * precedence over the defaults.
 */

export const SHORTCUT_ACTIONS = [
  "playPause",
  "returnToStart",
  "prev",
  "next",
  "nudgeBack",
  "nudgeForward",
  "nudgeBackBig",
  "nudgeForwardBig",
  "toggleLoop",
  "toggleCountIn",
  "toggleClick",
  "cycleSnap",
  "addMarker",
  "addSection",
  "comment",
  "abToggle",
  "zoomIn",
  "zoomOut",
  "zoomToLoop",
  "help",
  "clearSelection",
  /** Document viewer page turns (SPEC §11.4); only through a pedal mapping on the song page. */
  "pageNext",
  "pagePrev",
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

/** Actions a pedal can be mapped to (Settings → Keyboard). */
export const PEDAL_ACTIONS = [
  "playPause",
  "prev",
  "next",
  "toggleLoop",
  "returnToStart",
  "nudgeBack",
  "nudgeForward",
  "addMarker",
  "pageNext",
  "pagePrev",
] as const satisfies readonly ShortcutAction[];
export type PedalAction = (typeof PEDAL_ACTIONS)[number];

export type KeyMap = Record<string, PedalAction>;

export interface KeyLike {
  key: string;
  code: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export type Resolved =
  { action: ShortcutAction } | { action: "track"; index: number; op: "select" | "mute" | "solo" };

/** Maps a key event to an action; null for keys without a meaning on the song page. */
export function resolveKey(e: KeyLike, custom: KeyMap = {}): Resolved | null {
  if (e.ctrlKey || e.metaKey) return null;
  const mapped = !e.altKey && !e.shiftKey ? custom[e.code] : undefined;
  if (mapped) return { action: mapped };
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) {
    const index = Number(digit[1]) - 1;
    return { action: "track", index, op: e.altKey ? "mute" : e.shiftKey ? "solo" : "select" };
  }
  if (e.altKey) return null;
  switch (e.code) {
    case "Space":
      return { action: "playPause" };
    case "Enter":
    case "NumpadEnter":
      return { action: "returnToStart" };
    case "ArrowLeft":
      return { action: e.shiftKey ? "nudgeBackBig" : "nudgeBack" };
    case "ArrowRight":
      return { action: e.shiftKey ? "nudgeForwardBig" : "nudgeForward" };
    case "PageUp":
      return { action: "prev" };
    case "PageDown":
      return { action: "next" };
    case "Escape":
      return { action: "clearSelection" };
  }
  switch (e.key) {
    case "[":
      return { action: "prev" };
    case "]":
      return { action: "next" };
    case "l":
    case "L":
      return { action: "toggleLoop" };
    case "k":
    case "K":
      return { action: "toggleCountIn" };
    case "c":
    case "C":
      return { action: "toggleClick" };
    case "s":
    case "S":
      return { action: "cycleSnap" };
    case "m":
      return { action: "addMarker" };
    case "M":
      return { action: "addSection" };
    case "n":
    case "N":
      return { action: "comment" };
    case "v":
    case "V":
      return { action: "abToggle" };
    case "+":
    case "=":
      return { action: "zoomIn" };
    case "-":
    case "_":
      return { action: "zoomOut" };
    case "z":
    case "Z":
      return { action: "zoomToLoop" };
    case "?":
      return { action: "help" };
  }
  return null;
}

const KEYMAP_KEY = "bandroom.keymap";

/** The per-device pedal mapping (stored locally, SPEC §11.4). */
export function loadKeyMap(): KeyMap {
  try {
    const raw = localStorage.getItem(KEYMAP_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const out: KeyMap = {};
    if (parsed && typeof parsed === "object") {
      for (const [code, action] of Object.entries(parsed as Record<string, unknown>)) {
        const a = PEDAL_ACTIONS.find((p) => p === action);
        if (a) out[code] = a;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveKeyMap(map: KeyMap): void {
  try {
    localStorage.setItem(KEYMAP_KEY, JSON.stringify(map));
  } catch {
    // private mode: mapping lasts for this page only
  }
}

/** Assigns `code` to `action` (one key per action; a key serves one action). */
export function assignKey(map: KeyMap, action: PedalAction, code: string | null): KeyMap {
  const out: KeyMap = {};
  for (const [c, a] of Object.entries(map)) if (a !== action && c !== code) out[c] = a;
  if (code) out[code] = action;
  return out;
}

export function keyFor(map: KeyMap, action: PedalAction): string | null {
  return Object.entries(map).find(([, a]) => a === action)?.[0] ?? null;
}

/** Readable key name ("KeyA" → "A", "ArrowLeft" → "←"). */
export function keyLabel(code: string): string {
  const arrows: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
  };
  if (arrows[code]) return arrows[code];
  return code
    .replace(/^Key/, "")
    .replace(/^Digit/, "")
    .replace(/^Numpad/, "Num ");
}

export type PageTurn = "next" | "prev";

/**
 * Page turns in a focused document viewer (SPEC §10, §11.4): keys mapped to "next/previous page"
 * first, then PageDown/PageUp, →/←, Space/Shift+Space (what page-turner pedals send). Other
 * mapped keys keep their song-page meaning, so a pedal can still play/pause.
 */
export function resolvePageKey(e: KeyLike, custom: KeyMap = {}): PageTurn | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const mapped = !e.shiftKey ? custom[e.code] : undefined;
  if (mapped === "pageNext") return "next";
  if (mapped === "pagePrev") return "prev";
  if (mapped) return null;
  switch (e.code) {
    case "PageDown":
    case "ArrowRight":
      return "next";
    case "PageUp":
    case "ArrowLeft":
      return "prev";
    case "Space":
      return e.shiftKey ? "prev" : "next";
  }
  return null;
}
