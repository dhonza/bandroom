import type { TFunction } from "i18next";

/** Stable starts of render errors the server sets (`EDIT_STALLED`, a job's `lease expired`). */
const KNOWN = [
  ["EDIT_STALLED", "edit.progress.error.stalled"],
  ["lease expired", "edit.progress.error.workerStopped"],
] as const;

/**
 * A render's error as the progress list shows it: translated when the server's error is one of
 * the known stable ones, otherwise as it came (tool output, `QUOTA_EXCEEDED: …`).
 */
export function renderErrorText(error: string | null, t: TFunction): string | null {
  if (!error) return error;
  const known = KNOWN.find(([prefix]) => error.startsWith(prefix));
  return known ? t(known[1]) : error;
}
