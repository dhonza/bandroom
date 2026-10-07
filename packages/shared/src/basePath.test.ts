import { describe, expect, it } from "vitest";
import { basePathFromUrl, joinBasePath, normalizeBasePath } from "./basePath";

describe("normalizeBasePath", () => {
  it.each([
    ["", ""],
    ["/", ""],
    ["//", ""],
    ["bandroom", "/bandroom"],
    ["/bandroom/", "/bandroom"],
    ["/a//b/", "/a/b"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });
});

describe("basePathFromUrl", () => {
  it("returns empty string for a root URL", () => {
    expect(basePathFromUrl("https://bandroom.example.com")).toBe("");
    expect(basePathFromUrl("https://bandroom.example.com/")).toBe("");
  });

  it("returns the pathname for a sub-path URL", () => {
    expect(basePathFromUrl("https://example.com/bandroom/")).toBe("/bandroom");
  });
});

describe("joinBasePath", () => {
  it("joins root base", () => {
    expect(joinBasePath("", "/api/v1/meta")).toBe("/api/v1/meta");
  });

  it("joins sub-path base and adds a missing slash", () => {
    expect(joinBasePath("/bandroom", "api/v1/meta")).toBe("/bandroom/api/v1/meta");
    expect(joinBasePath("/bandroom/", "/healthz")).toBe("/bandroom/healthz");
  });
});
