import type { Practice } from "@bandroom/shared";
import type { TFunction } from "i18next";

/** A whole number with its sign: "+8", "−2" (a real minus sign), "0". */
export function signed(v: number): string {
  if (v > 0) return `+${v}`;
  if (v < 0) return `−${-v}`;
  return "0";
}

/**
 * A practice setting in a few words (SPEC §30.7): "85 %, −2 st, +8 ct", leaving out the parts at
 * their default (speed 100 %, 0 semitones, 0 cents).
 */
export function practiceLabel(p: Practice, t: TFunction): string {
  const parts: string[] = [];
  if (p.rate !== 1) parts.push(t("bounce.practiceSpeed", { value: Math.round(p.rate * 100) }));
  if (p.semitones !== 0) parts.push(t("bounce.practiceSemitones", { value: signed(p.semitones) }));
  if (p.cents !== 0) parts.push(t("bounce.practiceCents", { value: signed(p.cents) }));
  return parts.join(", ");
}
