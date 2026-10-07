import { describe, expect, it } from "vitest";
import { brandingLogoPath, logoAspectAllowed } from "./branding";

describe("logoAspectAllowed", () => {
  it("accepts up to 4:1 and rejects wider or empty images", () => {
    expect(logoAspectAllowed(400, 100)).toBe(true);
    expect(logoAspectAllowed(100, 400)).toBe(true);
    expect(logoAspectAllowed(401, 100)).toBe(false);
    expect(logoAspectAllowed(0, 100)).toBe(false);
    expect(logoAspectAllowed(100, 0)).toBe(false);
  });

  it("builds the public path", () => {
    expect(brandingLogoPath("ab")).toBe("/branding/logo/ab");
  });
});
