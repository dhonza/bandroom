import type { Practice } from "@bandroom/shared";
import type { TFunction } from "i18next";

/** A whole number with its sign: "+8", "−2" (a real minus sign), "0". */
export function signed(v: number): string {
  if (v > 0) return `+${v}`;
  if (v < 0) return `−${-v}`;
  return "0";
}

/**
 * A practice setting in a few words (SPEC §30.6, §30.7): "85 %, −2 st, +8 ct", leaving out the
 * parts at their default (speed 100 %, 0 semitones, 0 cents). The transport joins with " · ".
 */
export function practiceLabel(p: Practice, t: TFunction, separator = ", "): string {
  const parts: string[] = [];
  if (p.rate !== 1) parts.push(t("practice.percent", { value: Math.round(p.rate * 100) }));
  if (p.semitones !== 0) parts.push(t("practice.semitonesShort", { value: signed(p.semitones) }));
  if (p.cents !== 0) parts.push(t("practice.centsShort", { value: signed(p.cents) }));
  return parts.join(separator);
}
