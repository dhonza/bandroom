import { describe, expect, it } from "vitest";
import { LOOP_CACHE_BYTES, LoopCache, loopCacheFits } from "./loopCache";

const chunk = (frame: number, length: number, v: number) => ({
  lap: 0,
  frame,
  length,
  data: [new Float32Array(length).fill(v)],
});

describe("LoopCache (SPEC §6.4)", () => {
  it("fills one run from the loop start, skipping gaps between clips", () => {
    const c = new LoopCache();
    c.reset({ start: 100, end: 200 });
    const clips = [
      { start: 0, end: 140 },
      { start: 160, end: 400 },
    ];
    c.add(chunk(120, 20, 2), clips); // not from the start: ignored
    expect(c.bytes).toBe(0);
    c.add(chunk(90, 30, 1), clips); // covers 100–120
    c.add(chunk(120, 20, 2), clips); // 120–140, then the gap 140–160 is skipped
    expect(c.complete).toBe(false);
    c.add(chunk(160, 50, 3), clips);
    expect(c.complete).toBe(true);
    c.add(chunk(0, 10, 9), clips); // complete: ignored
    const a = new Float32Array(100);
    const b = new Float32Array(100);
    expect(c.read(100, 100, a, b, 0)).toBe(20); // the gap
    expect([a[0], a[25], a[45], a[70], b[99]]).toEqual([1, 2, 0, 3, 3]);
  });

  it("is off without a region and counts overlaps once", () => {
    const c = new LoopCache();
    c.reset(null);
    c.add(chunk(0, 10, 1), [{ start: 0, end: 100 }]);
    expect(c.complete).toBe(false);
    c.reset({ start: 0, end: 20 });
    c.add(chunk(0, 12, 1), [{ start: 0, end: 100 }]);
    c.add(chunk(8, 12, 2), [{ start: 0, end: 100 }]);
    const a = new Float32Array(20);
    expect(c.read(0, 20, a, new Float32Array(20), 0)).toBe(0);
    expect(a[10]).toBe(2);
  });

  it("fits when loop length × tracks × 2 channels × 4 bytes ≤ 64 MB", () => {
    const frames = LOOP_CACHE_BYTES / (16 * 8);
    expect(loopCacheFits({ start: 0, end: frames - 240 }, 16, 240)).toBe(true);
    expect(loopCacheFits({ start: 0, end: frames }, 16, 240)).toBe(false);
  });
});
