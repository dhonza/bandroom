import { create } from "zustand";

/**
 * Which top lanes of the timeline are hidden (SPEC §11.3), remembered per device: Sections and
 * Comments (markers and meter changes are on the ruler, SPEC §31.4). Marker guides across the
 * waveforms stay visible. Browser storage may be unavailable (private mode); the choice then lasts
 * for the page only.
 */
export const TOP_LANES = ["sections", "comments"] as const;
export type TopLane = (typeof TOP_LANES)[number];
export type HiddenLanes = Readonly<Record<TopLane, boolean>>;

const KEY = "bandroom.hiddenLanes";

const NONE_HIDDEN: HiddenLanes = { sections: false, comments: false };

function load(): HiddenLanes {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    const list = Array.isArray(parsed) ? (parsed as unknown[]) : [];
    const out = { ...NONE_HIDDEN };
    for (const k of TOP_LANES) out[k] = list.includes(k);
    return out;
  } catch {
    return NONE_HIDDEN;
  }
}

function save(hidden: HiddenLanes): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(TOP_LANES.filter((k) => hidden[k])));
  } catch {
    // per-device convenience only
  }
}

export const useLaneVisibility = create<{ hidden: HiddenLanes }>(() => ({ hidden: load() }));

function set(hidden: HiddenLanes): void {
  save(hidden);
  useLaneVisibility.setState({ hidden });
}

export function toggleLane(key: TopLane): void {
  const hidden = useLaneVisibility.getState().hidden;
  set({ ...hidden, [key]: !hidden[key] });
}

/** Hides (true) or shows (false) every top lane. */
export function setAllLanes(hidden: boolean): void {
  set({ sections: hidden, comments: hidden });
}

/** Re-reads the stored choice (tests). */
export function reloadLaneVisibility(): void {
  useLaneVisibility.setState({ hidden: load() });
}
