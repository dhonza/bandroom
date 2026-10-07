import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "../lib/media";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["week", 7 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

/** Locale-aware formatting via Intl (SPEC §12). */
export function makeFormatters(locale: string, now: () => number = Date.now) {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const dtf = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  return {
    dateTime: (ms: number) => dtf.format(ms),
    date: (ms: number) => df.format(ms),
    /** A 0–1 fraction as a whole percent ("42 %" in cs, "42%" in en). */
    percent: (fraction: number) => pct.format(fraction),
    /** A file size ("1.2 GB"). */
    bytes: (n: number) => formatBytes(n, locale),
    relative: (ms: number) => {
      const diff = ms - now();
      for (const [unit, size] of UNITS) {
        if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit);
      }
      return rtf.format(0, "minute");
    },
  };
}

export function useFormatters() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  return useMemo(() => makeFormatters(locale), [locale]);
}
