/**
 * How a Mixer track header fits its lane height (SPEC §25.9; DECISIONS 2026-10-07). The header
 * never clips its M/S buttons:
 * - `full`: name row with the version button, then M S fader ⚙ (wide headers only);
 * - `two`: a small name line, then M S (+ fader on wide headers) ⚙;
 * - `one`: name, M, S and ⚙ in one line, the buttons shrunk to the lane on mouse screens.
 */
export type HeaderTier = "full" | "two" | "one";

/** 44 px buttons, two 44 px rows and the gaps. */
const FULL_H = 100;
/** A 16 px name line above a 44 px button row. */
const TWO_H = 66;
/** A 44 px button row plus the lane border. */
const ONE_H = 46;
const SMALLEST_BUTTON = 20;

export function headerTier(height: number, compact: boolean): HeaderTier {
  if (!compact && height >= FULL_H) return "full";
  return height >= TWO_H ? "two" : "one";
}

/** The M/S/⚙ button size: 44 px (touch target) whenever the lane allows it. */
export function headerButtonSize(height: number, compact: boolean): number {
  if (headerTier(height, compact) !== "one") return 44;
  return Math.max(SMALLEST_BUTTON, Math.min(44, height - 2));
}

/**
 * The lowest Mixer lane on touch screens, where the buttons must stay 44 px: one line on wide
 * headers; on narrow (phone) headers the name needs its own line above the buttons.
 */
export function touchMinLaneHeight(compact: boolean): number {
  return compact ? TWO_H : ONE_H;
}
