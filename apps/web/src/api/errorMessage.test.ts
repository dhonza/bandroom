import { ERROR_CODES } from "@bandroom/shared";
import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import csCommon from "../locales/cs/common.json";
import enCommon from "../locales/en/common.json";
import { ApiError } from "./client";
import { KNOWN_ERROR_CODES, errorMessage } from "./errorMessage";

const LOCALES = { en: enCommon.errors, cs: csCommon.errors } as Record<
  string,
  Record<string, string>
>;

describe("error translations", () => {
  it.each(Object.keys(LOCALES))("%s has an errors.<CODE> key for every API code", (lng) => {
    const missing = [...ERROR_CODES, "NETWORK", "UNKNOWN"].filter(
      (code) => typeof LOCALES[lng]?.[code] !== "string",
    );
    expect(missing).toEqual([]);
  });

  it("knows every shared error code", () => {
    for (const code of ERROR_CODES) expect(KNOWN_ERROR_CODES.has(code)).toBe(true);
  });
});

describe("errorMessage", () => {
  const i18n = i18next.createInstance();
  beforeAll(async () => {
    await initI18n("en", i18n);
  });

  it("translates a server code", () => {
    const err = new ApiError(400, { code: "LINK_NAME_REQUIRED", message: "x" });
    expect(errorMessage(i18n.t, err)).toBe(enCommon.errors.LINK_NAME_REQUIRED);
    const midi = new ApiError(400, { code: "MIDI_SMPTE", message: "x" });
    expect(errorMessage(i18n.t, midi)).toBe(enCommon.errors.MIDI_SMPTE);
  });

  it("falls back to UNKNOWN for unknown codes and non-API errors", () => {
    const err = new ApiError(400, { code: "FROM_THE_FUTURE", message: "x" });
    expect(errorMessage(i18n.t, err)).toBe(enCommon.errors.UNKNOWN);
    expect(errorMessage(i18n.t, new Error("boom"))).toBe(enCommon.errors.UNKNOWN);
  });
});
