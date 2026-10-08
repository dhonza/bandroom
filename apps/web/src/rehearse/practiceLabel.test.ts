import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { practiceLabel, signed } from "./practiceLabel";

const en = i18next.createInstance();
const cs = i18next.createInstance();

beforeAll(async () => {
  await initI18n("en", en);
  await initI18n("cs", cs);
});

describe("practiceLabel (SPEC §30.7)", () => {
  it("lists the parts that are not at their default", () => {
    expect(practiceLabel({ rate: 0.85, semitones: -2, cents: 0 }, en.t)).toBe("85 %, −2 st");
    expect(practiceLabel({ rate: 1, semitones: 0, cents: 8 }, en.t)).toBe("+8 ct");
    expect(practiceLabel({ rate: 1.5, semitones: 3, cents: -32 }, cs.t)).toBe(
      "150 %, +3 pt, −32 ct",
    );
    expect(practiceLabel({ rate: 1, semitones: 0, cents: 0 }, en.t)).toBe("");
  });

  it("signs whole numbers with a real minus", () => {
    expect([signed(5), signed(-5), signed(0)]).toEqual(["+5", "−5", "0"]);
  });
});
