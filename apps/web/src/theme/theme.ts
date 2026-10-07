import {
  createTheme,
  Modal,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type MantineThemeOverride,
} from "@mantine/core";

/** Custom primary color (deep violet), tuned to read well on the dark default scheme. */
const brand: MantineColorsTuple = [
  "#f3edff",
  "#e0d7fa",
  "#beabf0",
  "#9a7de6",
  "#7c56de",
  "#693dd9",
  "#5f31d8",
  "#4f24c0",
  "#451fac",
  "#3a1899",
];

/**
 * The four custom colors of the 16-color palette (SPEC §11.5, DECISIONS 2026-10-06), as Mantine
 * 10-shade tuples so `color` props and `--mantine-color-<name>-<shade>` variables work like the
 * built-in ones. Labels on them pick black or white by contrast (`inkOn`).
 */
const brown: MantineColorsTuple = [
  "#f8f0eb",
  "#ecdcd0",
  "#dbbba4",
  "#c99a76",
  "#ba7d51",
  "#b06c3b",
  "#9c5c30",
  "#864d27",
  "#723f1f",
  "#5f3317",
];
const gold: MantineColorsTuple = [
  "#fbf6e6",
  "#f3e8c2",
  "#e8d596",
  "#dcc068",
  "#d1ad42",
  "#c9a227",
  "#b48f1c",
  "#977715",
  "#7b610f",
  "#5f4a09",
];
const mint: MantineColorsTuple = [
  "#e8fdf2",
  "#c6f8de",
  "#9ff2c8",
  "#76ebb1",
  "#55e59e",
  "#3fe192",
  "#33d68a",
  "#25b873",
  "#1a9a5f",
  "#0d7b4a",
];
const slate: MantineColorsTuple = [
  "#f1f4f8",
  "#e1e7ef",
  "#c3cfdd",
  "#a2b5c9",
  "#869fb8",
  "#7591ad",
  "#6a87a6",
  "#587391",
  "#4c6682",
  "#3d5772",
];

const baseTheme = {
  primaryColor: "brand",
  primaryShade: { light: 7, dark: 5 },
  colors: { brand, brown, gold, mint, slate },
  fontFamily: '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  headings: {
    fontFamily: '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  defaultRadius: "md",
  cursorType: "pointer",
} satisfies MantineThemeOverride;

export const theme = createTheme(baseTheme);

/**
 * Text colors that meet WCAG AA (4.5:1) on the page and card backgrounds: Mantine's dimmed gray
 * (dark-2 / gray-6) and the dark-scheme link violet (brand-4) do not (axe, e2e/a11y.spec.ts).
 */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: { "--mantine-color-dimmed": "var(--mantine-color-gray-7)" },
  dark: {
    "--mantine-color-dimmed": "#a0a0a0",
    "--mantine-color-anchor": "var(--mantine-color-brand-2)",
  },
});

/**
 * Theme with translated defaults for components whose built-in controls need an accessible name
 * (e.g. the modal close button). Rebuilt when the language changes.
 */
export function createAppTheme(labels: { close: string }) {
  return createTheme({
    ...baseTheme,
    components: {
      Modal: Modal.extend({ defaultProps: { closeButtonProps: { "aria-label": labels.close } } }),
    },
  });
}
