import {
  luminance,
  useComputedColorScheme,
  useMantineTheme,
  type MantineTheme,
} from "@mantine/core";

/** Black or white, whichever contrasts more with `fill` (WCAG relative luminance). */
export function inkOn(fill: string): "black" | "white" {
  const l = luminance(fill);
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? "black" : "white";
}

/** The filled shade of a theme color in the given scheme (`primaryShade`). */
export function filledShade(theme: MantineTheme, color: string, scheme: "light" | "dark"): string {
  const shade =
    typeof theme.primaryShade === "number" ? theme.primaryShade : theme.primaryShade[scheme];
  return theme.colors[color]?.[shade] ?? "#000000";
}

/**
 * Text color for initials on a filled theme color (author dots and avatars): white on dark fills,
 * black on light ones such as yellow or teal, so they stay readable (WCAG AA).
 */
export function useInkOnColor(): (color: string) => "black" | "white" {
  const theme = useMantineTheme();
  const scheme = useComputedColorScheme("dark");
  return (color) => inkOn(filledShade(theme, color, scheme));
}
