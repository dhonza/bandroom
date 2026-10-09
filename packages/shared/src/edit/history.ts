import { replay } from "./ops";
import { remapSteps } from "./remap";
import type { EditBase, EditOp } from "./schema";

/**
 * Undo history of a session (SPEC §24.3, §24.7): the op list and the cursor (number of applied
 * ops). Selection changes are not ops.
 */
export interface EditHistory {
  ops: EditOp[];
  cursor: number;
}

/** Adds an op at the cursor; ops after it (the redo tail) are dropped. */
export function pushOp(h: EditHistory, op: EditOp): EditHistory {
  return { ops: [...h.ops.slice(0, h.cursor), op], cursor: h.cursor + 1 };
}

export const canUndo = (h: EditHistory): boolean => h.cursor > 0;
export const canRedo = (h: EditHistory): boolean => h.cursor < h.ops.length;

export function undo(h: EditHistory): EditHistory {
  return canUndo(h) ? { ...h, cursor: h.cursor - 1 } : h;
}

export function redo(h: EditHistory): EditHistory {
  return canRedo(h) ? { ...h, cursor: h.cursor + 1 } : h;
}

/**
 * Folds the oldest applied ops into the base so that at most `keep` ops remain (SPEC §24.7): the
 * base gains their clips and timeline steps; undone ops are never folded. Replaying the result
 * gives the same clips.
 */
export function foldOps(
  base: EditBase,
  h: EditHistory,
  keep: number,
): { base: EditBase } & EditHistory {
  const n = Math.max(0, Math.min(h.cursor, h.ops.length - keep));
  if (n === 0) return { base, ops: h.ops, cursor: h.cursor };
  const folded = h.ops.slice(0, n);
  const state = replay(base, folded);
  return {
    base: {
      ...base,
      tracks: base.tracks.map((t, i) => ({ ...t, folded: state.tracks[i]?.clips ?? [] })),
      remap: remapSteps(base, folded),
      foldedOps: base.foldedOps + n,
    },
    ops: h.ops.slice(n),
    cursor: h.cursor - n,
  };
}
