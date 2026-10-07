import { PALETTE_COLORS } from "@bandroom/shared";

/**
 * The 16-color palette shared by tracks, sections, projects and comment authors (SPEC §11.5), defined once in
 * `@bandroom/shared`. Each entry is a Mantine color; shade choice per scheme lives in
 * {@link paletteShade} so labels keep AA contrast.
 */
export const TRACK_PALETTE = PALETTE_COLORS;

export type PaletteColor = (typeof TRACK_PALETTE)[number];

export function paletteShade(scheme: "dark" | "light"): number {
  return scheme === "dark" ? 5 : 7;
}

export function paletteColor(index: number): PaletteColor {
  const n = TRACK_PALETTE.length;
  return TRACK_PALETTE[((index % n) + n) % n] ?? "blue";
}
