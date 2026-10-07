import { describe, expect, it } from "vitest";
import { assignLanes, CreateMarkerSchema, SECTION_PRESET_COLORS, SECTION_PRESETS } from "./markers";

describe("assignLanes (SPEC §7.4)", () => {
  it("keeps sequential sections in lane 0 and stacks overlaps", () => {
    const lanes = assignLanes([
      { id: "c", startSec: 20, endSec: 40 },
      { id: "a", startSec: 0, endSec: 20 },
      { id: "b", startSec: 10, endSec: 15 },
      { id: "d", startSec: 12, endSec: 30 },
      { id: "e", startSec: 30, endSec: 35, createdAt: 2 },
      { id: "f", startSec: 30, endSec: 31, createdAt: 1 },
    ]);
    expect(Object.fromEntries(lanes)).toEqual({ a: 0, b: 1, d: 2, c: 0, f: 1, e: 2 });
  });
});

describe("marker schemas", () => {
  it("requires sections to end after they start and trims names", () => {
    expect(
      CreateMarkerSchema.safeParse({ type: "section", name: "A", color: "red", startSec: 1 })
        .success,
    ).toBe(false);
    const ok = CreateMarkerSchema.parse({
      type: "marker",
      name: " Solo ",
      color: "red",
      startSec: 1,
    });
    expect(ok).toMatchObject({ name: "Solo", note: "" });
    expect(new Set(SECTION_PRESETS.map((p) => SECTION_PRESET_COLORS[p])).size).toBe(8);
  });
});
