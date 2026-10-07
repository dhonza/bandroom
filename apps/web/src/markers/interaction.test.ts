import type { Marker } from "@bandroom/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTapForTests, tapItem } from "./interaction";
import { registerPlayer, resetTimelineUiForTests, useTimelineUi } from "./store";

const item = (id: string, type: "section" | "marker"): Marker => ({
  id,
  songId: "s",
  type,
  name: id,
  color: "red",
  note: "",
  startSec: 10,
  endSec: type === "section" ? 20 : null,
  anchor: "time",
  startBeat: null,
  endBeat: null,
  lane: 0,
  createdBy: null,
  createdByName: null,
  createdAt: 0,
  updatedAt: 0,
});

let seeks: number[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetTimelineUiForTests();
  resetTapForTests();
  seeks = [];
  registerPlayer({
    position: () => 0,
    duration: () => 100,
    seek: (s) => seeks.push(s),
    setLoop: () => undefined,
    togglePlay: () => undefined,
    isPlaying: () => false,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("double click / double tap on timeline items (SPEC §25.7)", () => {
  it("selects a section on a tap and opens its editor on a second tap, without looping", () => {
    const s = item("verse", "section");
    tapItem(s, true);
    expect(useTimelineUi.getState()).toMatchObject({
      selection: { start: 10, end: 20 },
      picked: "verse",
      editor: null,
    });
    vi.advanceTimersByTime(200);
    tapItem(s, true);
    expect(useTimelineUi.getState()).toMatchObject({
      editor: { mode: "edit", id: "verse" },
      loopOn: false,
    });
  });

  it("picks a marker and jumps there, then edits it on a double tap", () => {
    const m = item("hit", "marker");
    tapItem(m, true);
    expect(useTimelineUi.getState().picked).toBe("hit");
    expect(seeks).toEqual([10]);
    tapItem(m, true);
    expect(useTimelineUi.getState().editor).toEqual({ mode: "edit", id: "hit" });
  });

  it("does nothing extra for items the user may not edit", () => {
    const s = item("chorus", "section");
    tapItem(s, false);
    tapItem(s, false);
    expect(useTimelineUi.getState()).toMatchObject({
      editor: null,
      loopOn: false,
      picked: "chorus",
    });
  });

  it("needs both taps on the same item within 400 ms", () => {
    const a = item("a", "section");
    tapItem(a, true);
    vi.advanceTimersByTime(450);
    tapItem(a, true);
    expect(useTimelineUi.getState().editor).toBeNull();
    tapItem(item("b", "section"), true);
    expect(useTimelineUi.getState().editor).toBeNull();
    // A third tap after a double starts over.
    tapItem(a, true);
    tapItem(a, true);
    tapItem(a, true);
    expect(useTimelineUi.getState().editor).toEqual({ mode: "edit", id: "a" });
  });
});
