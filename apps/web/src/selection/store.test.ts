import { describe, expect, it } from "vitest";
import { createSelectionStore, selectionOf } from "./store";

describe("selection store (SPEC §26.1)", () => {
  it("starts, toggles, selects all and exits", () => {
    const store = createSelectionStore();
    const sel = () => selectionOf(store.getState(), "project:a");
    expect(sel().active).toBe(false);
    sel().start();
    expect(sel().active).toBe(true);
    expect([...sel().ids]).toEqual([]);
    sel().toggle("s1");
    sel().toggle("s2");
    sel().toggle("s1");
    expect([...sel().ids]).toEqual(["s2"]);
    sel().setAll(["s1", "s2", "s3"]);
    expect(sel().ids.size).toBe(3);
    sel().exit();
    expect(sel().active).toBe(false);
    expect(sel().ids.size).toBe(0);
  });

  it("a toggle outside selection mode starts it with that item (long-press, checkbox)", () => {
    const store = createSelectionStore();
    selectionOf(store.getState(), "song:x").toggle("t1");
    expect([...selectionOf(store.getState(), "song:x").ids]).toEqual(["t1"]);
  });

  it("another list's selection reads as inactive and is replaced by a new one", () => {
    const store = createSelectionStore();
    selectionOf(store.getState(), "project:a").start("s1");
    expect(selectionOf(store.getState(), "project:b").active).toBe(false);
    selectionOf(store.getState(), "project:b").toggle("s9");
    expect(selectionOf(store.getState(), "project:a").active).toBe(false);
    expect([...selectionOf(store.getState(), "project:b").ids]).toEqual(["s9"]);
  });
});
