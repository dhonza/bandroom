import type { ImportRunStatus } from "@bandroom/shared";

/** Badge color per import run status. */
export const STATUS_COLORS: Record<ImportRunStatus, string> = {
  connected: "gray",
  scanning: "blue",
  review: "yellow",
  running: "blue",
  done: "teal",
  failed: "red",
  cancelled: "gray",
};
