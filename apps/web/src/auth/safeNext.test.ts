import { describe, expect, it } from "vitest";
import { safeNext } from "./safeNext";

describe("safeNext", () => {
  it.each([
    [null, "/"],
    ["/settings", "/settings"],
    ["//evil.example", "/"],
    ["https://evil.example", "/"],
    ["settings", "/"],
    ["/", "/"],
    ["/songs/s1?t=12#c", "/songs/s1?t=12#c"],
    ["/\\evil.example", "/"],
    ["/\t/evil.example", "/"],
    ["/\n/evil.example", "/"],
    ["/songs\u0000", "/"],
    ["/a\\b", "/a\\b"],
  ])("%j → %j", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});
