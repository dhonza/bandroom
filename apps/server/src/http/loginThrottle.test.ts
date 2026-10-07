import { describe, expect, it } from "vitest";
import { LoginThrottle } from "./loginThrottle";

const opts = {
  maxPerUsername: 5,
  windowMs: 15 * 60_000,
  ipFreeFailures: 10,
  ipMaxBackoffMs: 60_000,
  maxEntries: 3,
};

describe("LoginThrottle", () => {
  it("blocks a username after 5 failures for the rest of the window", () => {
    const t = new LoginThrottle(opts);
    for (let i = 0; i < 4; i++) t.recordFailure("jana", `ip${i}`, 1000);
    expect(t.retryAfterMs("jana", "x", 1000)).toBe(0);
    t.recordFailure("jana", "ip9", 1000);
    expect(t.retryAfterMs("jana", "x", 2000)).toBe(opts.windowMs - 1000);
    expect(t.retryAfterMs("other", "x", 2000)).toBe(0);
    expect(t.retryAfterMs("jana", "x", 1000 + opts.windowMs)).toBe(0);
  });

  it("resets the username counter on success", () => {
    const t = new LoginThrottle(opts);
    for (let i = 0; i < 5; i++) t.recordFailure("jana", "ip", 0);
    t.recordSuccess("jana");
    expect(t.retryAfterMs("jana", "other-ip", 1)).toBe(0);
  });

  it("backs off exponentially per IP across usernames", () => {
    const t = new LoginThrottle({ ...opts, maxEntries: 100 });
    for (let i = 0; i < 10; i++) t.recordFailure(`u${i}`, "1.2.3.4", 0);
    expect(t.retryAfterMs("fresh", "1.2.3.4", 0)).toBe(1000);
    t.recordFailure("u10", "1.2.3.4", 0);
    t.recordFailure("u11", "1.2.3.4", 0);
    expect(t.retryAfterMs("fresh", "1.2.3.4", 0)).toBe(4000);
    for (let i = 0; i < 10; i++) t.recordFailure(`v${i}`, "1.2.3.4", 0);
    expect(t.retryAfterMs("fresh", "1.2.3.4", 0)).toBe(opts.ipMaxBackoffMs);
    expect(t.retryAfterMs("fresh", "5.6.7.8", 0)).toBe(0);
  });

  it("caps memory by evicting the oldest keys", () => {
    const t = new LoginThrottle(opts);
    for (let i = 0; i < 5; i++) t.recordFailure("first", `ip${i}`, 0);
    for (const name of ["b", "c", "d"]) t.recordFailure(name, "z", 0);
    expect(t.retryAfterMs("first", "q", 1)).toBe(0);
  });
});
