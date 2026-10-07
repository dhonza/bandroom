import { describe, expect, it } from "vitest";
import { UUID_RE, uuidv7 } from "./ids";

describe("uuidv7", () => {
  it("has the v7 layout and encodes the timestamp", () => {
    const id = uuidv7(0x0189_abcd_ef01, (b) => b.fill(0xff));
    expect(id).toMatch(UUID_RE);
    expect(id.startsWith("0189abcd-ef01-7")).toBe(true);
    expect(id[19]).toMatch(/[89ab]/);
  });

  it("sorts by time", () => {
    expect(uuidv7(1_000_000) < uuidv7(2_000_000)).toBe(true);
  });

  it("is strictly increasing within the same millisecond", () => {
    const ms = 3_000_000;
    const ids = Array.from({ length: 1000 }, () => uuidv7(ms));
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids);
  });

  it("stays monotonic when the clock goes backwards or the counter overflows", () => {
    const a = uuidv7(5_000_000);
    const b = uuidv7(4_000_000);
    expect(b > a).toBe(true);
    const many = Array.from({ length: 5000 }, () => uuidv7(6_000_000));
    expect([...many].sort()).toEqual(many);
    expect(many.at(-1)?.slice(0, 13)).not.toBe(many[0]?.slice(0, 13)); // borrowed next ms
  });
});
