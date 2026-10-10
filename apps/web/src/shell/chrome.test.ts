import { afterEach, describe, expect, it } from "vitest";
import {
  isChromeToggleKey,
  chromeAutoOnly,
  chromeCollapsed,
  isTypingTarget,
  setChromeAuto,
  showChrome,
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

describe("automatic hiding (SPEC §31.6)", () => {
  afterEach(() => {
    setChromeAuto(false);
  });

  it("collapses without remembering; Show navigation ends it until the next time", () => {
    setChromeAuto(true);
    expect(chromeCollapsed(useChrome.getState())).toBe(true);
    expect(chromeAutoOnly(useChrome.getState())).toBe(true);
    expect(localStorage.getItem("bandroom.chromeHidden")).toBeNull();
    setChromeAuto(true);
    showChrome();
    expect(chromeCollapsed(useChrome.getState())).toBe(false);
    setChromeAuto(false);
    setChromeAuto(true);
    expect(chromeCollapsed(useChrome.getState())).toBe(true);
    // The manual choice wins and keeps its restore button.
    setChromeHidden(true);
    expect(chromeAutoOnly(useChrome.getState())).toBe(false);
    showChrome();
    expect(useChrome.getState().hidden).toBe(false);
    setChromeAuto(false);
    showChrome();
    expect(chromeCollapsed(useChrome.getState())).toBe(false);
  });
});
