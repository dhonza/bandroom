import type { EditReviewWarningCode } from "@bandroom/shared";

/**
 * Pure helpers of the Apply/Bounce review (SPEC §24.8–§24.9): the processing time shown as a
 * range, the size against the quota and the free disk, and the timeline follow-up as countable
 * parts. The dialogs render these; the numbers come from `reviewEditSession`.
 */

/** Processing time as a range (seconds): the server's estimate is a rough single number. */
export function processingRange(estimateSec: number): { lo: number; hi: number } {
  const sec = Math.max(0, estimateSec);
  const lo = Math.max(1, Math.floor(sec * 0.6));
  const hi = Math.max(lo + 1, Math.ceil(sec * 1.6));
  return { lo, hi };
}

/** The range in the unit that reads best: seconds under two minutes, else whole minutes. */
export function processingLabel(range: { lo: number; hi: number }): {
  unit: "sec" | "min";
  lo: number;
  hi: number;
} {
  if (range.hi < 120) return { unit: "sec", lo: range.lo, hi: range.hi };
  const lo = Math.max(1, Math.floor(range.lo / 60));
  return { unit: "min", lo, hi: Math.max(lo + 1, Math.ceil(range.hi / 60)) };
}

export type SizeVerdict = "ok" | "overQuota" | "overDisk";

/** Whether the new audio fits; the disk wins (it blocks everyone). */
export function sizeVerdict(r: Pick<ReviewView, "fitsQuota" | "fitsDisk">): SizeVerdict {
  if (!r.fitsDisk) return "overDisk";
  if (!r.fitsQuota) return "overQuota";
  return "ok";
}

export interface TimelineCounts {
  markersMoved: number;
  markersDeleted: number;
  sectionsMoved: number;
  sectionsDeleted: number;
  commentsMoved: number;
  commentsEditedOut: number;
  tempoChanged: boolean;
}

export type TimelineKey =
  | "markersMoved"
  | "markersDeleted"
  | "sectionsMoved"
  | "sectionsDeleted"
  | "commentsMoved"
  | "commentsEditedOut"
  | "tempo";

export interface TimelinePart {
  key: TimelineKey;
  count: number;
}

/** The non-zero parts of the timeline follow-up, in reading order ("2 markers moved, …"). */
export function timelineParts(c: TimelineCounts): TimelinePart[] {
  const parts: TimelinePart[] = [];
  const add = (key: Exclude<TimelineKey, "tempo">, count: number) => {
    if (count > 0) parts.push({ key, count });
  };
  add("markersMoved", c.markersMoved);
  add("markersDeleted", c.markersDeleted);
  add("sectionsMoved", c.sectionsMoved);
  add("sectionsDeleted", c.sectionsDeleted);
  add("commentsMoved", c.commentsMoved);
  add("commentsEditedOut", c.commentsEditedOut);
  if (c.tempoChanged) parts.push({ key: "tempo", count: 1 });
  return parts;
}

/** A review as the dialogs show it (built from the server's `EditReview`). */
export interface ReviewView {
  /** Outputs: an edited track (Apply, Bounce to versions/tracks) or a new song's track. */
  tracks: { key: string; name: string; oldSec: number | null; newSec: number }[];
  /** Estimated size of the new audio (bytes). */
  bytes: number;
  /** What is left of the user's quota (null: no quota). */
  quotaLeft: number | null;
  /** Free disk on the server (null: unknown). */
  diskFree: number | null;
  /** The server's verdict (quota with its overhead, disk with its reserve). */
  fitsQuota: boolean;
  fitsDisk: boolean;
  /** The server's processing estimate (seconds). */
  estimateSec: number;
  /** Warning codes with the names of the tracks they concern. */
  warnings: { code: EditReviewWarningCode; tracks: string[] }[];
  /** The timeline follow-up (null when none is written, e.g. new tracks). */
  timeline: TimelineCounts | null;
}
