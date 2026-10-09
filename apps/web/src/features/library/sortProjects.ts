import type { LibraryProject } from "@bandroom/shared";

export const SORT_KEYS = ["name", "created", "modified", "accessed"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const SORT_ORDERS = ["asc", "desc"] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];
export const LIBRARY_FILTERS = ["all", "mine", "shared"] as const;
export type LibraryFilter = (typeof LIBRARY_FILTERS)[number];

type Sortable = Pick<
  LibraryProject,
  "name" | "starred" | "createdAt" | "updatedAt" | "lastAccessedAt"
>;

/** The time a sort key orders by (name: last modified, shown next to the project). */
export function sortTime(p: Sortable, key: SortKey): number | null {
  if (key === "created") return p.createdAt;
  if (key === "accessed") return p.lastAccessedAt;
  return p.updatedAt;
}

/**
 * Library order (SPEC §11): starred projects first, then the rest; the chosen key and order apply
 * within each group. Projects never accessed come last in either order; ties go by name.
 */
export function sortProjects<T extends Sortable>(
  list: readonly T[],
  key: SortKey,
  order: SortOrder,
): T[] {
  const dir = order === "asc" ? 1 : -1;
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return [...list].sort((a, b) => {
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    if (key === "name") return dir * byName(a, b);
    const ta = sortTime(a, key);
    const tb = sortTime(b, key);
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return dir * (ta - tb);
    }
    return byName(a, b);
  });
}

/** "Mine": projects the user created; "Shared with me": everything else they can see. */
export function filterProjects<T extends Pick<LibraryProject, "createdBy">>(
  list: readonly T[],
  filter: LibraryFilter,
  userId: string,
): T[] {
  if (filter === "all") return [...list];
  return list.filter((p) => (p.createdBy === userId) === (filter === "mine"));
}
