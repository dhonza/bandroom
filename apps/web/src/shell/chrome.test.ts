import { afterEach, describe, expect, it } from "vitest";
import {
  isChromeToggleKey,
  isTypingTarget,
  setChromeHidden,
  toggleChrome,
  useChrome,
} from "./chrome";

const key = (over: Partial<Parameters<typeof isChromeToggleKey>[0]> = {}) => ({
  key: "F",
  code: "KeyF",
  shiftKey: true,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...over,
});

afterEach(() => {
  setChromeHidden(false);
  localStorage.clear();
});

describe("hide navigation (SPEC §25.2)", () => {
  it("toggles and remembers the choice on this device", () => {
    expect(useChrome.getState().hidden).toBe(false);
    toggleChrome();
    expect(useChrome.getState().hidden).toBe(true);
    expect(localStorage.getItem("bandroom.chromeHidden")).toBe("1");
    toggleChrome();
    expect(useChrome.getState().hidden).toBe(false);
    expect(localStorage.getItem("bandroom.chromeHidden")).toBeNull();
  });

  it("uses Shift+F only", () => {
    expect(isChromeToggleKey(key())).toBe(true);
    expect(isChromeToggleKey(key({ shiftKey: false, key: "f" }))).toBe(false);
    expect(isChromeToggleKey(key({ metaKey: true }))).toBe(false);
    expect(isChromeToggleKey(key({ altKey: true }))).toBe(false);
    expect(isChromeToggleKey(key({ code: "KeyG" }))).toBe(false);
  });

  it("ignores keys typed into fields", () => {
    const input = document.createElement("input");
    const div = document.createElement("div");
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(div)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
