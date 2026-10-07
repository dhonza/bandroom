import { describe, expect, it } from "vitest";
import { compareLocale, flatten, pluralCategories } from "./check";

const en = {
  a: { b: "Hello {{name}}" },
  songs_one: "{{count}} song",
  songs_other: "{{count}} songs",
};

describe("flatten", () => {
  it("produces dotted keys", () => {
    expect([...flatten(en).keys()]).toEqual(["a.b", "songs_one", "songs_other"]);
  });
});

describe("pluralCategories", () => {
  it("knows Czech needs one/few/many/other", () => {
    expect(pluralCategories("cs")).toEqual(["one", "few", "many", "other"]);
  });
});

describe("compareLocale", () => {
  const ref = { locale: "en", messages: en };

  it("passes a complete Czech locale", () => {
    const cs = {
      a: { b: "Ahoj {{name}}" },
      songs_one: "{{count}} píseň",
      songs_few: "{{count}} písně",
      songs_many: "{{count}} písně",
      songs_other: "{{count}} písní",
    };
    expect(compareLocale("common", ref, { locale: "cs", messages: cs })).toEqual([]);
  });

  it("reports missing keys, plural forms, extras and variable mismatches", () => {
    const cs = {
      a: { b: "Ahoj {{jmeno}}" },
      songs_one: "{{count}} píseň",
      songs_other: "{{count}} písní",
      songs_two: "x",
      stale: "old",
    };
    const problems = compareLocale("common", ref, { locale: "cs", messages: cs }).map(
      (i) => `${i.key}: ${i.problem}`,
    );
    expect(problems).toEqual([
      "a.b: interpolation mismatch",
      "stale: extra (not in reference)",
      "songs_few: missing plural form",
      "songs_many: missing plural form",
      "songs_two: plural form not used by cs",
    ]);
  });
});
