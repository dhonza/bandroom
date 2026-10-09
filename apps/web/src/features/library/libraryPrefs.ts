import {
  LIBRARY_FILTERS,
  SORT_KEYS,
  SORT_ORDERS,
  type LibraryFilter,
  type SortKey,
  type SortOrder,
} from "./sortProjects";

export const LIBRARY_VIEWS = ["grid", "list"] as const;
export type LibraryView = (typeof LIBRARY_VIEWS)[number];

export interface LibraryPrefs {
  view: LibraryView;
  sort: SortKey;
  order: SortOrder;
  filter: LibraryFilter;
}

export const DEFAULT_LIBRARY_PREFS: LibraryPrefs = {
  view: "grid",
  sort: "modified",
  order: "desc",
  filter: "all",
};

const STORAGE_KEY = "bandroom.library.prefs";

const pick = <T extends string>(allowed: readonly T[], v: unknown, fallback: T): T =>
  allowed.find((a) => a === v) ?? fallback;

/** The Library's view, sort and filter on this device; defaults when storage is unavailable. */
export function loadLibraryPrefs(): LibraryPrefs {
  let raw: unknown;
  try {
    const text = window.localStorage.getItem(STORAGE_KEY);
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_LIBRARY_PREFS;
  return {
    view: pick(LIBRARY_VIEWS, o.view, d.view),
    sort: pick(SORT_KEYS, o.sort, d.sort),
    order: pick(SORT_ORDERS, o.order, d.order),
    filter: pick(LIBRARY_FILTERS, o.filter, d.filter),
  };
}

export function saveLibraryPrefs(prefs: LibraryPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or blocked storage: the choice lasts for this visit only.
  }
}
