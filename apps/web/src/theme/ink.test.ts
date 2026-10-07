import { PALETTE_COLORS } from "@bandroom/shared";
import { createTheme, DEFAULT_THEME, luminance, mergeMantineTheme } from "@mantine/core";
import { describe, expect, it } from "vitest";
import { filledShade, inkOn } from "./ink";
import { theme as appTheme } from "./theme";

describe("inkOn", () => {
  it("picks the more readable of black and white", () => {
    expect(inkOn("#000000")).toBe("white");
    expect(inkOn("#ffffff")).toBe("black");
    expect(inkOn("#fcc419")).toBe("black"); // yellow
    expect(inkOn("#20c997")).toBe("black"); // teal
    expect(inkOn("#845ef7")).toBe("black"); // violet: white is only 4.3:1
    expect(inkOn("#693dd9")).toBe("white");
    expect(inkOn("#c92a2a")).toBe("white");
  });
});

describe("filledShade", () => {
  it("uses the scheme's primary shade", () => {
    const theme = mergeMantineTheme(
      DEFAULT_THEME,
      createTheme({ primaryShade: { light: 7, dark: 5 } }),
    );
    expect(filledShade(theme, "yellow", "dark")).toBe(DEFAULT_THEME.colors.yellow[5]);
    expect(filledShade(theme, "yellow", "light")).toBe(DEFAULT_THEME.colors.yellow[7]);
    expect(filledShade({ ...theme, primaryShade: 6 }, "red", "dark")).toBe(
      DEFAULT_THEME.colors.red[6],
    );
    expect(filledShade(theme, "nope", "dark")).toBe("#000000");
  });
});

describe("palette colors (SPEC §11.5)", () => {
  const theme = mergeMantineTheme(DEFAULT_THEME, appTheme);
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

  it("are all theme colors with ten shades", () => {
    for (const c of PALETTE_COLORS) expect(theme.colors[c], c).toHaveLength(10);
  });

  it("keep labels at WCAG AA (4.5:1) on their filled shade in both schemes", () => {
    for (const c of PALETTE_COLORS)
      for (const scheme of ["light", "dark"] as const) {
        const fill = filledShade(theme, c, scheme);
        const ink = inkOn(fill) === "black" ? 0 : 1;
        expect(ratio(luminance(fill), ink), `${c} ${scheme}`).toBeGreaterThanOrEqual(4.5);
      }
  });
});
