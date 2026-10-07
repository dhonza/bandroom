/**
 * Parses a single `bytes=start-end` range (multipart ranges are not needed by our clients).
 * Shared by the server's blob route and the service worker's offline cache (SPEC §6.4, §13).
 */
export function parseRange(
  header: string | null | undefined,
  size: number,
): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid";
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === "" && b) {
    start = Math.max(0, size - Number(b));
    end = size - 1;
  } else if (a) {
    start = Number(a);
    end = b ? Math.min(Number(b), size - 1) : size - 1;
  } else {
    return "invalid";
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}
