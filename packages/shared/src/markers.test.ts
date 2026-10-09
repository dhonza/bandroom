import { describe, expect, it } from "vitest";
import {
  assignLanes,
  conversionPlan,
  ConvertMarkersSchema,
  CreateMarkerSchema,
  SECTION_PRESET_COLORS,
  SECTION_PRESETS,
  type ConvertibleMarker,
} from "./markers";

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

describe("conversionPlan (markers ↔ sections)", () => {
  const item = (
    id: string,
    type: "marker" | "section",
    startSec: number,
    endSec: number | null = null,
  ): ConvertibleMarker => ({
    id,
    type,
    name: id.toUpperCase(),
    color: "red",
    note: `note ${id}`,
    startSec,
    endSec,
    anchor: "musical",
  });
  const items = [
    item("a", "marker", 10),
    item("b", "marker", 20),
    item("b2", "marker", 20),
    item("c", "marker", 35),
    item("s", "section", 40, 60),
  ];

  it("spans each marker to the next marker of the song, the last to the song end", () => {
    const plan = conversionPlan(items, ["c", "a"], "section", 90);
    expect(plan.skippedIds).toEqual([]);
    expect(plan.creates).toEqual([
      {
        sourceId: "a",
        item: {
          type: "section",
          name: "A",
          color: "red",
          note: "note a",
          startSec: 10,
          endSec: 20,
          anchor: "musical",
        },
      },
      { sourceId: "c", item: expect.objectContaining({ startSec: 35, endSec: 90 }) as unknown },
    ]);
  });

  it("uses the next later time for markers at the same position", () => {
    const plan = conversionPlan(items, ["b", "b2"], "section", 90);
    expect(plan.creates.map((c) => [c.sourceId, c.item.endSec])).toEqual([
      ["b", 35],
      ["b2", 35],
    ]);
  });

  it("skips the last marker without a song end or past it, unknown ids and the target type", () => {
    expect(conversionPlan(items, ["c"], "section", null)).toEqual({
      creates: [],
      skippedIds: ["c"],
    });
    expect(conversionPlan(items, ["c"], "section", 35).skippedIds).toEqual(["c"]);
    expect(conversionPlan(items, ["x", "s", "a", "a"], "section", 90)).toMatchObject({
      skippedIds: ["x", "s"],
      creates: [{ sourceId: "a" }],
    });
  });

  it("turns sections into markers at their start", () => {
    const plan = conversionPlan(items, ["s", "a"], "marker", null);
    expect(plan.skippedIds).toEqual(["a"]);
    expect(plan.creates).toEqual([
      {
        sourceId: "s",
        item: {
          type: "marker",
          name: "S",
          color: "red",
          note: "note s",
          startSec: 40,
          endSec: null,
          anchor: "musical",
        },
      },
    ]);
  });

  it("validates the request", () => {
    const id = "0192f0c4-0000-7000-8000-000000000000";
    expect(ConvertMarkersSchema.safeParse({ ids: [id], to: "section" }).success).toBe(true);
    expect(ConvertMarkersSchema.safeParse({ ids: [], to: "section" }).success).toBe(false);
    expect(ConvertMarkersSchema.safeParse({ ids: ["x"], to: "marker" }).success).toBe(false);
  });
});
