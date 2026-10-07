import { describe, expect, it } from "vitest";
import { SlotLimiter } from "./slotLimiter";

describe("SlotLimiter", () => {
  it("hands out one slot by default and refuses while it is taken", () => {
    const l = new SlotLimiter();
    const release = l.tryAcquire();
    expect(release).not.toBeNull();
    expect(l.inUse).toBe(1);
    expect(l.tryAcquire()).toBeNull();
    release?.();
    expect(l.inUse).toBe(0);
    expect(l.tryAcquire()).not.toBeNull();
  });

  it("releases exactly once, however often release is called", () => {
    const l = new SlotLimiter(2);
    const a = l.tryAcquire();
    const b = l.tryAcquire();
    expect(l.tryAcquire()).toBeNull();
    a?.();
    a?.();
    a?.();
    expect(l.inUse).toBe(1);
    b?.();
    expect(l.inUse).toBe(0);
  });
});
