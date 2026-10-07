import type { LinkStats, PublicLink } from "@bandroom/shared";

const pad = (n: number) => String(n).padStart(2, "0");

/** `yyyy-mm-dd` in local time, for `<input type="date">`. */
export function toDateInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A link picked to expire "on" a day stays open until the end of that local day. */
export function endOfDay(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Default expiry for new links: two weeks from today. */
export function defaultExpiry(now: number = Date.now()): string {
  return toDateInput(now + 14 * 24 * 3600_000);
}

/** i18n keys describing what a link shares, e.g. ["links.scope.song", "links.versions.all"]. */
export function linkSummaryKeys(link: Pick<PublicLink, "scopeType" | "versions">): string[] {
  if (link.scopeType === "versions") return ["links.scope.versions"];
  return [`links.scope.${link.scopeType}`, `links.versions.${link.versions}`];
}

/** Stats worth showing in a one-line summary (zeros left out, opens always). */
export function statParts(stats: LinkStats): { key: string; count: number }[] {
  const parts: { key: string; count: number }[] = [{ key: "opens", count: stats.opens }];
  for (const key of ["visitors", "plays", "downloads", "comments", "passwordFailures"] as const) {
    if (stats[key] > 0) parts.push({ key, count: stats[key] });
  }
  return parts;
}
