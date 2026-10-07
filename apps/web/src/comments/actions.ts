import type { Comment } from "@bandroom/shared";
import { isLoopable } from "../markers/model";
import { activePlayer, loopRange, positionNow, seekTo, useTimelineUi } from "../markers/store";
import { highlightComment, startComposer } from "./store";

/** Tap on a pin or a comment's time: seek there, highlight it and open the panel (SPEC §8). */
export function tapComment(c: Pick<Comment, "id" | "startSec">): void {
  highlightComment(c.id);
  if (c.startSec !== null) seekTo(c.startSec);
}

/**
 * "Comment at playhead" / `N` (SPEC §8): the time is captured now, not on submit; an active
 * selection makes it a range by default.
 */
export function commentAtPlayhead(at?: number): void {
  const selection = useTimelineUi.getState().selection;
  startComposer({
    startSec: activePlayer() || at !== undefined ? Math.max(0, at ?? positionNow()) : null,
    range: at === undefined && isLoopable(selection) ? selection : null,
    trackId: null,
  });
}

/** "Loop this" on a range comment. */
export function loopComment(c: Comment): void {
  if (c.startSec === null || c.endSec === null) return;
  loopRange({ start: c.startSec, end: c.endSec });
}
