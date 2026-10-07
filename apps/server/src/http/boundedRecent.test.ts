import { describe, expect, it } from "vitest";
import { AccessCache } from "./blobs";
import { BoundedRecent } from "./boundedRecent";

describe("BoundedRecent", () => {
  it("treats a key as recent strictly inside the window by default", () => {
    const r = new BoundedRecent(100, 10);
    expect(r.isRecent("a", 0)).toBe(false);
    r.mark("a", 0);
    expect(r.isRecent("a", 99)).toBe(true);
    expect(r.isRecent("a", 100)).toBe(false);
  });

  it("can count the window's last moment as recent", () => {
    const r = new BoundedRecent(100, 10, true);
    r.mark("a", 0);
    expect(r.isRecent("a", 100)).toBe(true);
    expect(r.isRecent("a", 101)).toBe(false);
  });

  it("marks only keys that are not recent", () => {
    const r = new BoundedRecent(100, 10);
    expect(r.markIfNew("a", 0)).toBe(true);
    expect(r.markIfNew("a", 50)).toBe(false);
    expect(r.markIfNew("a", 99)).toBe(false); // not re-marked at 50
    expect(r.markIfNew("a", 100)).toBe(true);
  });

  it("clears itself when full", () => {
    const r = new BoundedRecent(100, 2);
    r.mark("a", 0);
    r.mark("b", 0);
    r.mark("c", 0); // full: forgets a and b
    expect(r.isRecent("a", 1)).toBe(false);
    expect(r.isRecent("b", 1)).toBe(false);
    expect(r.isRecent("c", 1)).toBe(true);
  });
});

describe("AccessCache", () => {
  it("remembers a decision for five minutes", () => {
    const c = new AccessCache();
    c.add("s:h", 1000);
    expect(c.has("s:h", 1000 + 5 * 60_000 - 1)).toBe(true);
    expect(c.has("s:h", 1000 + 5 * 60_000)).toBe(false);
    expect(c.has("other", 1000)).toBe(false);
  });
});
