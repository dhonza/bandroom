import { describe, expect, it } from "vitest";
import { makeFormatters } from "./format";

describe("makeFormatters", () => {
  it("formats a fraction as a whole, locale-aware percent", () => {
    expect(makeFormatters("en").percent(0.421)).toBe("42%");
    expect(makeFormatters("en").percent(1)).toBe("100%");
    // Czech puts a (non-breaking) space before the sign.
    expect(makeFormatters("cs").percent(0.5)).toBe("50 %");
  });

  it("formats relative times against the given clock", () => {
    const f = makeFormatters("en", () => 10 * 3600_000);
    expect(f.relative(8 * 3600_000)).toBe("2 hours ago");
    expect(f.relative(10 * 3600_000)).toBe("this minute");
  });
});
