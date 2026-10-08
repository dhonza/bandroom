/** Small output helpers for the CLI (no dependencies). */

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? String(v) : v.toFixed(v >= 100 ? 0 : 1)} ${UNITS[u]}`;
}

export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function formatAgo(ms: number | null | undefined, now: number = Date.now()): string {
  if (ms === null || ms === undefined) return "-";
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return "in the future";
  if (s < 90) return `${s}s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)}m ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * A time from `--since`: a duration back from now (`30m`, `24h`, `7d`), epoch milliseconds, or an
 * ISO date. Throws on anything else.
 */
export function parseSince(value: string, now: number = Date.now()): number {
  const d = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (d) {
    const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[d[2] as "s" | "m" | "h" | "d"];
    return now - Number(d[1]) * mult;
  }
  if (/^\d{10,}$/.test(value)) return Number(value);
  const t = Date.parse(value);
  if (Number.isNaN(t))
    throw new Error(`Cannot read --since "${value}" (use 30m, 24h, 7d or a date)`);
  return t;
}

/** A plain text table: columns padded to their widest cell, long cells cut. */
export function table(headers: string[], rows: (string | number | null | undefined)[][], max = 60) {
  const cells = rows.map((r) =>
    r.map((c) => {
      const s = c === null || c === undefined ? "-" : String(c).replace(/\s+/g, " ");
      return s.length > max ? `${s.slice(0, max - 1)}…` : s;
    }),
  );
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((r) => (r[i] ?? "").length)),
  );
  const line = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)].join("\n");
}
