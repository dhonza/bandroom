import { compileTempo, type Marker } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import {
  boundaries,
  clampRange,
  dragRange,
  edgeModeAt,
  layoutFor,
  guidesOf,
  isDoubleTap,
  markerPatch,
  sectionRangeFrom,
  validateMarkerForm,
  loopTarget,
  nextBoundary,
  effectiveSnap,
  musicalSnap,
  nextSnapMode,
  nudge,
  snapWith,
  numberedName,
  orderedRange,
  presetForName,
  prevBoundary,
  returnTarget,
  sectionAt,
  sectionMatching,
  sectionsOf,
  snapSec,
} from "./model";

const m = (over: Partial<Marker>): Marker => ({
  id: over.id ?? over.name ?? "x",
  songId: "s",
  type: "section",
  name: "X",
  color: "blue",
  note: "",
  startSec: 0,
  endSec: null,
  anchor: "time",
  startBeat: null,
  endBeat: null,
  lane: 0,
  createdBy: null,
  createdByName: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const song: Marker[] = [
  m({ name: "Verse", startSec: 10, endSec: 30 }),
  m({ name: "Chorus", startSec: 30, endSec: 50 }),
  m({ name: "Solo", startSec: 40, endSec: 60, lane: 1 }),
  m({ name: "Break", type: "marker", startSec: 45 }),
];

describe("sections and boundaries", () => {
  it("finds the section under the playhead, preferring lane 0", () => {
    expect(sectionAt(song, 5)).toBeNull();
    expect(sectionAt(song, 10)?.name).toBe("Verse");
    expect(sectionAt(song, 30)?.name).toBe("Chorus");
    expect(sectionAt(song, 45)?.name).toBe("Chorus");
    expect(sectionAt(song, 55)?.name).toBe("Solo");
    expect(sectionsOf(song).map((s) => s.name)).toEqual(["Verse", "Chorus", "Solo"]);
  });

  it("navigates between boundaries with a tolerance behind the playhead", () => {
    const b = boundaries(song);
    expect(b).toEqual([10, 30, 40, 45, 50, 60]);
    expect(prevBoundary(b, 30.2)).toBe(10);
    expect(prevBoundary(b, 31)).toBe(30);
    expect(prevBoundary(b, 5)).toBe(0);
    expect(nextBoundary(b, 30)).toBe(40);
    expect(nextBoundary(b, 0)).toBe(10);
    expect(nextBoundary(b, 60)).toBeNull();
  });
});

describe("snapping (SPEC §7.5)", () => {
  it("snaps to the nearest target within the threshold", () => {
    expect(snapSec(29.9, [10, 30, 40], 0.2)).toBe(30);
    expect(snapSec(29.5, [10, 30, 40], 0.2)).toBe(29.5);
    expect(snapSec(35.05, [35, 35.1], 0.2)).toBe(35);
    expect(nextSnapMode("off")).toBe("markers");
    expect(nextSnapMode("markers")).toBe("off");
    expect(nextSnapMode("beat")).toBe("off"); // no tempo: acts as markers
    expect(nextSnapMode("markers", true)).toBe("bar");
    expect(nextSnapMode("quarter", true)).toBe("off");
    expect(effectiveSnap("half", false)).toBe("markers");
    expect(effectiveSnap("half", true)).toBe("half");
    expect(musicalSnap("markers")).toBeNull();
  });
});

describe("loops and transport (SPEC §7.6)", () => {
  it("loops the selection, else the section under the playhead", () => {
    expect(loopTarget({ start: 1, end: 3 }, song, 35)).toEqual({ start: 1, end: 3 });
    expect(loopTarget({ start: 1, end: 1.1 }, song, 35)).toEqual({ start: 30, end: 50 });
    expect(loopTarget(null, song, 5)).toBeNull();
  });

  it("returns to the loop start, the play start, then the song start", () => {
    expect(returnTarget({ start: 30, end: 50 }, 12, false)).toBe(30);
    expect(returnTarget(null, 12, false)).toBe(12);
    expect(returnTarget(null, null, false)).toBe(0);
    expect(returnTarget({ start: 30, end: 50 }, 12, true)).toBe(0);
  });

  it("nudges by 1 s or 5 s within the song", () => {
    expect(nudge(10, 1, false, 100)).toBe(11);
    expect(nudge(10, -1, true, 100)).toBe(5);
    expect(nudge(2, -1, true, 100)).toBe(0);
    expect(nudge(98, 1, true, 100)).toBe(100);
  });

  it("nudges by beats and bars with a tempo map; snaps to grid lines and markers", () => {
    const grid = compileTempo({
      map: { segments: [{ startBeat: 0, bpm: 120, meter: { num: 4, den: 4 }, barIndex: 0 }] },
      bar1OffsetSec: 0,
    });
    expect(nudge(1.2, 1, false, 100, grid)).toBe(1.5);
    expect(nudge(1.2, -1, false, 100, grid)).toBe(1);
    expect(nudge(1.2, 1, true, 100, grid)).toBe(2);
    expect(nudge(0.2, -1, true, 100, grid)).toBe(0);
    expect(snapWith(1.26, "beat", [], 0.1, grid)).toBe(1.26); // nearest line 0.24 away
    expect(snapWith(1.45, "beat", [], 0.1, grid)).toBe(1.5);
    expect(snapWith(1.45, "beat", [1.44], 0.1, grid)).toBe(1.44);
    expect(snapWith(1.45, "bar", [], 0.1, grid)).toBe(1.45);
    expect(snapWith(1.45, "off", [1.44], 0.1, grid)).toBe(1.45);
    expect(snapWith(1.45, "markers", [1.5], 0.1, null)).toBe(1.5);
  });

  it("orders and clamps ranges and matches sections", () => {
    expect(orderedRange(5, 2)).toEqual({ start: 2, end: 5 });
    expect(clampRange({ start: -1, end: 200 }, 100)).toEqual({ start: 0, end: 100 });
    expect(sectionMatching(song, { start: 30, end: 50 })?.name).toBe("Chorus");
    expect(sectionMatching(song, { start: 30, end: 49 })).toBeNull();
  });
});

describe("section names", () => {
  it("numbers repeated preset names and recognizes presets", () => {
    expect(numberedName("Chorus", song)).toBe("Chorus 2");
    expect(numberedName("Chorus", [...song, m({ name: "Chorus 2" })])).toBe("Chorus 3");
    expect(numberedName("Bridge", song)).toBe("Bridge");
    const label = (p: string) =>
      p === "prechorus" ? "Pre-chorus" : (p[0] ?? "").toUpperCase() + p.slice(1);
    expect(presetForName("Chorus 2", label)).toBe("chorus");
    expect(presetForName("pre-chorus", label)).toBe("prechorus");
    expect(presetForName("Groove", label)).toBeNull();
  });
});

describe("marker guides", () => {
  it("draws point markers as guides across the lanes", () => {
    expect(guidesOf(song)).toEqual([{ start: 45, color: "blue" }]);
  });
});

describe("taps and edits", () => {
  it("counts a second tap on the same item within 400 ms as a double tap", () => {
    expect(isDoubleTap(null, "a", 1000)).toBe(false);
    expect(isDoubleTap({ id: "a", at: 1000 }, "a", 1399)).toBe(true);
    expect(isDoubleTap({ id: "a", at: 1000 }, "a", 1400)).toBe(false);
    expect(isDoubleTap({ id: "b", at: 1000 }, "a", 1100)).toBe(false);
  });

  it("starts a section at the tap up to the next boundary or 10 s on", () => {
    expect(sectionRangeFrom(song, 12, 100)).toEqual({ start: 12, end: 30 });
    expect(sectionRangeFrom(song, 65, 100)).toEqual({ start: 65, end: 75 });
    expect(sectionRangeFrom(song, 95, 100)).toEqual({ start: 95, end: 100 });
  });

  it("patches dragged items, with the anchor only when it changes", () => {
    const sec = m({ startSec: 1, endSec: 2 });
    expect(markerPatch(sec, { start: 3, end: 4 }, "time")).toEqual({ startSec: 3, endSec: 4 });
    const pt = m({ type: "marker", startSec: 1 });
    expect(markerPatch(pt, { start: 3, end: 3 }, "musical")).toEqual({
      startSec: 3,
      anchor: "musical",
    });
  });

  it("validates the editor form", () => {
    expect(validateMarkerForm("section", { name: " ", start: "0:01", end: "0:02" })).toEqual({
      ok: false,
      error: "validation.required",
    });
    expect(validateMarkerForm("section", { name: "A", start: "0:02", end: "0:02" })).toEqual({
      ok: false,
      error: "markers.badTimes",
    });
    expect(validateMarkerForm("section", { name: "A", start: "x", end: "0:02" })).toEqual({
      ok: false,
      error: "markers.badTimes",
    });
    expect(validateMarkerForm("section", { name: " A ", start: "1", end: "0:02" })).toEqual({
      ok: true,
      name: "A",
      startSec: 1,
      endSec: 2,
    });
    expect(validateMarkerForm("marker", { name: "B", start: "1.5", end: "junk" })).toEqual({
      ok: true,
      name: "B",
      startSec: 1.5,
      endSec: null,
    });
  });
});

describe("timeline items", () => {
  it("sizes the Sections lane for touch (compact with a mouse); markers are on the ruler", () => {
    expect(layoutFor(song, false)).toEqual({
      sectionH: 22,
      sectionLanes: 2,
      height: 44,
      rulerH: 28,
      coarse: false,
    });
    expect(
      layoutFor(
        song.filter((m) => m.type !== "section"),
        true,
      ),
    ).toEqual({ sectionH: 44, sectionLanes: 0, height: 0, rulerH: 36, coarse: true });
  });

  it("gives a hidden Sections lane no height", () => {
    expect(layoutFor(song, true, { hidden: { sections: true } })).toMatchObject({
      sectionLanes: 0,
      height: 0,
    });
    expect(layoutFor([], false)).toMatchObject({ height: 0 });
  });

  it("grabs a section's edges and a marker's body", () => {
    const rect = { left: 100, right: 300, width: 200 };
    expect(edgeModeAt(false, 101, rect)).toBe("move");
    expect(edgeModeAt(true, 105, rect)).toBe("start");
    expect(edgeModeAt(true, 295, rect)).toBe("end");
    expect(edgeModeAt(true, 200, rect)).toBe("move");
    // Narrow items: edges are a quarter of the width.
    expect(edgeModeAt(true, 106, { left: 100, right: 120, width: 20 })).toBe("move");
    expect(edgeModeAt(true, 103, { left: 100, right: 120, width: 20 })).toBe("start");
  });

  it("moves within the song, snapping by the start, else by the end of a section", () => {
    const none = (s: number) => s;
    const orig = { start: 10, end: 20 };
    expect(dragRange("move", orig, 5, 100, true, none)).toEqual({ start: 15, end: 25 });
    expect(dragRange("move", orig, -50, 100, true, none)).toEqual({ start: 0, end: 10 });
    expect(dragRange("move", orig, 95, 100, true, none)).toEqual({ start: 90, end: 100 });
    const toStart = (s: number) => (Math.abs(s - 16) < 1 ? 16 : s);
    expect(dragRange("move", orig, 5.5, 100, true, toStart)).toEqual({ start: 16, end: 26 });
    const toEnd = (s: number) => (Math.abs(s - 30) < 1 ? 30 : s);
    expect(dragRange("move", orig, 9.5, 100, true, toEnd)).toEqual({ start: 20, end: 30 });
    expect(dragRange("move", orig, 9.5, 100, false, toEnd)).toEqual({ start: 19.5, end: 29.5 });
  });

  it("resizes without crossing the other edge", () => {
    const none = (s: number) => s;
    const orig = { start: 10, end: 20 };
    expect(dragRange("start", orig, -15, 100, true, none)).toEqual({ start: 0, end: 20 });
    expect(dragRange("start", orig, 30, 100, true, none)).toEqual({ start: 19.95, end: 20 });
    expect(dragRange("end", orig, 100, 100, true, none)).toEqual({ start: 10, end: 100 });
    expect(dragRange("end", orig, -30, 100, true, none)).toEqual({ start: 10, end: 10.05 });
  });
});
