import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { detectLanguage, initI18n } from "./i18n";

describe("detectLanguage", () => {
  it("prefers the stored choice", () => {
    expect(detectLanguage("en", "cs", ["en-US"])).toBe("cs");
  });

  it("uses the first supported browser language", () => {
    expect(detectLanguage("en", null, ["de-DE", "cs-CZ", "en"])).toBe("cs");
    expect(detectLanguage("cs", null, ["en-GB"])).toBe("en");
  });

  it("falls back to the instance default", () => {
    expect(detectLanguage("cs", null, ["de-DE"])).toBe("cs");
    expect(detectLanguage("en", "xx", [])).toBe("en");
  });
});

describe("plurals (SPEC §12)", () => {
  const i18n = i18next.createInstance();
  beforeAll(async () => {
    await initI18n("cs", i18n);
  });

  it.each([
    [1, "1 píseň"],
    [2, "2 písně"],
    [5, "5 písní"],
    [1.5, "1,5 písně"],
  ])("cs: %d → %s", (count, expected) => {
    expect(i18n.t("counts.songs", { count, lng: "cs" })).toBe(expected);
  });

  it.each([
    [1, "1 song"],
    [2, "2 songs"],
    [5, "5 songs"],
    [1.5, "1.5 songs"],
  ])("en: %d → %s", (count, expected) => {
    expect(i18n.t("counts.songs", { count, lng: "en" })).toBe(expected);
  });

  it.each([
    ["cs", 1, "👍: 1 reakce"],
    ["cs", 3, "👍: 3 reakce"],
    ["cs", 5, "👍: 5 reakcí"],
    ["en", 1, "👍: 1 reaction"],
    ["en", 2, "👍: 2 reactions"],
  ])("reaction label %s %d → %s", (lng, count, expected) => {
    expect(i18n.t("comments.reactionLabel", { emoji: "👍", count, lng })).toBe(expected);
  });
});
