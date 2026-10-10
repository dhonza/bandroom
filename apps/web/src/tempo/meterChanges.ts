import { sameMeter, type TempoGrid } from "@bandroom/shared";

/**
 * Whether the song changes meter anywhere (SPEC §31.5): only then the transport shows the meter
 * at the playhead. A new bar with the same meter (a region of its own) is no change.
 */
export function hasMeterChanges(grid: TempoGrid | null): boolean {
  if (!grid) return false;
  const first = grid.regions[0];
  if (!first) return false;
  return grid.regions.some((r) => !sameMeter(r.meter, first.meter));
}
