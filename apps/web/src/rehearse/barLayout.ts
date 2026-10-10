import { useMediaQuery } from "@mantine/hooks";
import { COARSE_POINTER_QUERY, LANDSCAPE_PHONE_QUERY, PHONE_QUERY } from "../shell/mediaQueries";

/**
 * How the song page lays out its header and control bar (SPEC §31): desktop and tablets, a
 * portrait phone, or a phone in landscape (a short viewport with a coarse pointer; it wins over
 * the phone width, which a small phone in landscape still matches).
 */
export type BarLayout = "desktop" | "phone" | "landscape";

export function barLayoutOf(phone: boolean, landscape: boolean): BarLayout {
  if (landscape) return "landscape";
  return phone ? "phone" : "desktop";
}

export function useBarLayout(): BarLayout {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const landscape = useMediaQuery(LANDSCAPE_PHONE_QUERY, false, { getInitialValueInEffect: false });
  return barLayoutOf(phone, landscape);
}

/** A finger is the main pointer: 44 px buttons in the bar (SPEC §11.1.3, §31.1). */
export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER_QUERY, false, { getInitialValueInEffect: false });
}

/** Icon button sizes of the bar: row 2 (context row) and row 1 (transport). */
export function barSizes(coarse: boolean): { row: number; transport: number; play: number } {
  return coarse ? { row: 44, transport: 44, play: 48 } : { row: 28, transport: 34, play: 40 };
}
