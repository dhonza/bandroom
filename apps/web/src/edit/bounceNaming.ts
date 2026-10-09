import { editSongTitle, type EditSongNaming, type EditSongRange } from "@bandroom/shared";

/**
 * Split into songs in the Bounce dialog (SPEC §24.9): which candidate ranges are chosen and what
 * the new songs are called. The default titles are the shared naming (`editSongTitle`, the same
 * as the server's); a title typed in the dialog replaces its default.
 */

export type NamedRange = Pick<EditSongRange, "id" | "name" | "startFrame" | "endFrame">;

/** Chosen ranges in timeline order. */
export function chosenRanges<R extends NamedRange>(
  ranges: readonly R[],
  chosen: ReadonlySet<string>,
): R[] {
  return ranges
    .filter((r) => chosen.has(r.id))
    .sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
}

export interface TitledRange<R extends NamedRange = NamedRange> {
  range: R;
  /** The default title for the current naming options. */
  defaultTitle: string;
  /** What the song will be called: the typed title, else the default. */
  title: string;
  edited: boolean;
}

/** The longest song title the server takes (`SongTitleSchema`). */
const MAX_TITLE = 200;

/**
 * The titles of the chosen ranges in timeline order: defaults from the naming options (numbered
 * among the chosen ones), replaced by typed titles (`edits` by range id; blank = the default).
 */
export function titleRanges<R extends NamedRange>(
  ranges: readonly R[],
  chosen: ReadonlySet<string>,
  naming: EditSongNaming,
  sessionTitle: string,
  edits: Readonly<Record<string, string>>,
): TitledRange<R>[] {
  const list = chosenRanges(ranges, chosen);
  return list.map((range, i) => {
    const defaultTitle = editSongTitle(range, i, list.length, naming, sessionTitle);
    const typed = edits[range.id]?.trim() ?? "";
    return {
      range,
      defaultTitle,
      title: typed === "" ? defaultTitle : typed.slice(0, MAX_TITLE),
      edited: typed !== "",
    };
  });
}

/** Toggles one range in the chosen set. */
export function toggleRange(chosen: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(chosen);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The chosen set: every range except the ones switched off (all are on by default). */
export function chosenSet(ranges: readonly NamedRange[], off: ReadonlySet<string>): Set<string> {
  return new Set(ranges.map((r) => r.id).filter((id) => !off.has(id)));
}
