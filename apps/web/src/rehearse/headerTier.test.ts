import { describe, expect, it } from "vitest";
import { headerButtonSize, headerTier, touchMinLaneHeight } from "./headerTier";

describe("Mixer track header tiers", () => {
  it("shows the full strip only on tall wide headers", () => {
    expect(headerTier(100, false)).toBe("full");
    expect(headerTier(240, true)).toBe("two");
    expect(headerTier(99, false)).toBe("two");
    expect(headerTier(66, false)).toBe("two");
    expect(headerTier(65, true)).toBe("one");
    expect(headerTier(28, false)).toBe("one");
  });

  it("keeps 44 px buttons while they fit and shrinks them on short lanes", () => {
    expect(headerButtonSize(84, false)).toBe(44);
    expect(headerButtonSize(66, true)).toBe(44);
    expect(headerButtonSize(46, false)).toBe(44);
    expect(headerButtonSize(40, false)).toBe(38);
    expect(headerButtonSize(28, true)).toBe(26);
    expect(headerButtonSize(10, false)).toBe(20);
  });

  it("keeps 44 px buttons at the touch minimum", () => {
    for (const compact of [false, true]) {
      const min = touchMinLaneHeight(compact);
      expect(headerButtonSize(min, compact)).toBe(44);
    }
    expect(headerTier(touchMinLaneHeight(true), true)).toBe("two");
  });
});
