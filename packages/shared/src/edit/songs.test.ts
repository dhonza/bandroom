import { describe, expect, it } from "vitest";
import type { TrackClips } from "./ops";
import type { EditClip } from "./schema";
import {
  clipsInRange,
  DEFAULT_EDIT_SONG_NAMING,
  editSongRanges,
  editSongTitle,
  editSongTrackName,
  type RangeMarker,
} from "./songs";

const S = 48_000;
const clip = (start: number, len: number): EditClip => ({
  id: `c${start}`,
  sourceVersionId: "v",
  sourceStartFrame: 0,
  startFrame: start,
  lengthFrames: len,
  gainDb: 0,
  fadeInFrames: 0,
  fadeOutFrames: 0,
  fadeInShape: "equalPower",
  fadeOutShape: "equalPower",
});
const tracks = (...clips: EditClip[]): TrackClips[] => [{ trackId: "t", clips }];
const marker = (id: string, sec: number, name = id): RangeMarker => ({
  id,
  type: "marker",
  name,
  startSec: sec,
  endSec: null,
  lane: 0,
});
const section = (id: string, a: number, b: number, lane = 0): RangeMarker => ({
  id,
  type: "section",
  name: id,
  startSec: a,
  endSec: b,
  lane,
});

describe("editSongRanges", () => {
  it("takes lane-0 sections, clipped to the end, in timeline order, without silent ones", () => {
    const r = editSongRanges(
      [
        section("B", 10, 30),
        section("A", 0, 10),
        section("upper", 0, 5, 1),
        section("silent", 40, 45),
        section("late", 60, 70),
      ],
      tracks(clip(0, 25 * S), clip(50 * S, 10 * S)),
      55 * S,
    );
    expect(r.sections.map((x) => [x.id, x.startFrame / S, x.endFrame / S])).toEqual([
      ["A", 0, 10],
      ["B", 10, 30],
    ]);
  });

  it("makes ranges between markers, from 0:00 and to the end", () => {
    const r = editSongRanges(
      [marker("m2", 20, "Second"), marker("m1", 5, "First"), marker("past", 99)],
      tracks(clip(0, 40 * S)),
      40 * S,
    );
    expect(r.markers.map((x) => [x.id, x.source, x.startFrame / S, x.endFrame / S])).toEqual([
      ["start", "start", 0, 5],
      ["m1", "marker", 5, 20],
      ["m2", "marker", 20, 40],
    ]);
    expect(r.sections).toEqual([]);
  });

  it("has no start range when the first marker is at 0:00, and drops empty ranges", () => {
    const r = editSongRanges(
      [marker("a", 0), marker("b", 10), marker("c", 10)],
      tracks(clip(0, 20 * S)),
      20 * S,
    );
    expect(r.markers.map((x) => x.id)).toEqual(["a", "c"]);
  });
});

describe("naming", () => {
  it("titles by name, session and name, numbered", () => {
    const n = DEFAULT_EDIT_SONG_NAMING;
    expect(editSongTitle({ name: "Intro" }, 0, 3, n, "Rehearsal")).toBe("Intro");
    expect(
      editSongTitle({ name: "Intro" }, 0, 3, { ...n, title: "sessionAndName" }, "Rehearsal"),
    ).toBe("Rehearsal – Intro");
    expect(editSongTitle({ name: "Outro" }, 9, 10, { ...n, numbered: true }, "R")).toBe("10 Outro");
    expect(editSongTitle({ name: "x" }, 4, 120, { ...n, numbered: true }, "R")).toBe("005 x");
    expect(editSongTitle({ name: " " }, 0, 1, n, "Rehearsal")).toBe("Rehearsal");
  });

  it("names tracks, optionally with the range", () => {
    const n = DEFAULT_EDIT_SONG_NAMING;
    expect(editSongTrackName({ name: "Intro" }, "Guitar", n)).toBe("Guitar");
    expect(
      editSongTrackName({ name: "Intro" }, "Guitar", { ...n, trackNames: "rangePrefix" }),
    ).toBe("Intro – Guitar");
    expect(editSongTrackName({ name: "" }, "Guitar", { ...n, trackNames: "rangePrefix" })).toBe(
      "Guitar",
    );
  });
});

describe("clipsInRange", () => {
  it("cuts clips to the range with fades at the cut edges and moves them to 0", () => {
    const a = clip(0, 100);
    const b = { ...clip(150, 100), fadeOutFrames: 10 };
    const c = clip(300, 50);
    const out = clipsInRange([c, b, a], 50, 200, { fadeIn: 4, fadeOut: 6 });
    expect(out.map((x) => [x.id, x.startFrame, x.sourceStartFrame, x.lengthFrames])).toEqual([
      ["c0", 0, 50, 50],
      ["c150", 100, 0, 50],
    ]);
    expect(out.map((x) => [x.fadeInFrames, x.fadeOutFrames])).toEqual([
      [4, 0],
      [0, 6],
    ]);
  });

  it("clamps the edge fades to half the piece", () => {
    const [x] = clipsInRange([clip(0, 100)], 90, 95, { fadeIn: 50, fadeOut: 50 });
    expect([x?.lengthFrames, x?.fadeInFrames, x?.fadeOutFrames]).toEqual([5, 2, 2]);
  });
});
