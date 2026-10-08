import { describe, expect, it } from "vitest";
import { parseClock } from "../player/format";
import { assignKey, keyFor, keyLabel, resolveKey, resolvePageKey, type KeyLike } from "./keymap";

const k = (over: Partial<KeyLike>): KeyLike => ({
  key: "",
  code: "",
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...over,
});

describe("keyboard shortcuts (SPEC §11.4)", () => {
  it("resolves the default table", () => {
    expect(resolveKey(k({ code: "Space", key: " " }))).toEqual({ action: "playPause" });
    expect(resolveKey(k({ code: "Enter", key: "Enter" }))).toEqual({ action: "returnToStart" });
    expect(resolveKey(k({ code: "BracketLeft", key: "[" }))).toEqual({ action: "prev" });
    expect(resolveKey(k({ code: "ArrowRight", shiftKey: true }))).toEqual({
      action: "nudgeForwardBig",
    });
    expect(resolveKey(k({ code: "KeyL", key: "l" }))).toEqual({ action: "toggleLoop" });
    expect(resolveKey(k({ code: "KeyM", key: "M", shiftKey: true }))).toEqual({
      action: "addSection",
    });
    expect(resolveKey(k({ code: "Digit3", key: "3" }))).toEqual({
      action: "track",
      index: 2,
      op: "select",
    });
    expect(resolveKey(k({ code: "Digit1", key: "¡", altKey: true }))).toMatchObject({ op: "mute" });
    expect(resolveKey(k({ code: "Digit1", key: "!", shiftKey: true }))).toMatchObject({
      op: "solo",
    });
    expect(resolveKey(k({ code: "KeyS", key: "s", metaKey: true }))).toBeNull();
    expect(resolveKey(k({ code: "KeyQ", key: "q" }))).toBeNull();
    // By the character, so Z works on QWERTZ layouts too (SPEC §25.8).
    expect(resolveKey(k({ code: "KeyY", key: "z" }))).toEqual({ action: "zoomToLoop" });
  });

  it("lets a pedal mapping override the defaults", () => {
    const map = assignKey({}, "toggleLoop", "ArrowRight");
    expect(resolveKey(k({ code: "ArrowRight" }), map)).toEqual({ action: "toggleLoop" });
    const moved = assignKey(map, "playPause", "ArrowRight");
    expect(moved).toEqual({ ArrowRight: "playPause" });
    expect(keyFor(moved, "playPause")).toBe("ArrowRight");
    expect(keyFor(assignKey(moved, "playPause", null), "playPause")).toBeNull();
    expect(keyLabel("KeyB")).toBe("B");
    expect(keyLabel("ArrowLeft")).toBe("←");
  });
});

describe("document page turns (SPEC §10, §11.4)", () => {
  it("uses page-turner keys by default", () => {
    expect(resolvePageKey(k({ code: "PageDown" }))).toBe("next");
    expect(resolvePageKey(k({ code: "ArrowRight" }))).toBe("next");
    expect(resolvePageKey(k({ code: "Space" }))).toBe("next");
    expect(resolvePageKey(k({ code: "Space", shiftKey: true }))).toBe("prev");
    expect(resolvePageKey(k({ code: "PageUp" }))).toBe("prev");
    expect(resolvePageKey(k({ code: "ArrowLeft" }))).toBe("prev");
    expect(resolvePageKey(k({ code: "ArrowDown" }))).toBeNull(); // keeps scrolling
    expect(resolvePageKey(k({ code: "PageDown", ctrlKey: true }))).toBeNull();
  });

  it("follows the pedal mapping; other mapped keys keep their song meaning", () => {
    const map = assignKey(assignKey({}, "pageNext", "KeyB"), "playPause", "ArrowRight");
    expect(resolvePageKey(k({ code: "KeyB" }), map)).toBe("next");
    expect(resolvePageKey(k({ code: "ArrowRight" }), map)).toBeNull();
    expect(resolveKey(k({ code: "KeyB", key: "b" }), map)).toEqual({ action: "pageNext" });
    expect(resolvePageKey(k({ code: "KeyA" }), assignKey({}, "pagePrev", "KeyA"))).toBe("prev");
  });
});

describe("parseClock", () => {
  it("reads m:ss.mmm and seconds", () => {
    expect(parseClock("1:23.5")).toBe(83.5);
    expect(parseClock("83,25")).toBe(83.25);
    expect(parseClock("0:01:00")).toBe(60);
    expect(parseClock("abc")).toBeNull();
    expect(parseClock("")).toBeNull();
  });
});

describe("practice shortcuts (SPEC §30.6)", () => {
  it("maps Shift+, / Shift+. to speed and Alt+↓/↑ to pitch", () => {
    expect(resolveKey(k({ code: "Comma", key: "<", shiftKey: true }))).toEqual({
      action: "practiceSlower",
    });
    expect(resolveKey(k({ code: "Period", key: ">", shiftKey: true }))).toEqual({
      action: "practiceFaster",
    });
    expect(resolveKey(k({ code: "Comma", key: "," }))).toBeNull();
    expect(resolveKey(k({ code: "ArrowUp", altKey: true }))).toEqual({
      action: "practicePitchUp",
    });
    expect(resolveKey(k({ code: "ArrowDown", altKey: true }))).toEqual({
      action: "practicePitchDown",
    });
    expect(resolveKey(k({ code: "ArrowDown", altKey: true, shiftKey: true }))).toBeNull();
    expect(resolveKey(k({ code: "KeyX", altKey: true }))).toBeNull();
  });

  it("lets a pedal trigger the practice actions", () => {
    expect(resolveKey(k({ code: "KeyP" }), { KeyP: "practiceReset" })).toEqual({
      action: "practiceReset",
    });
  });
});
