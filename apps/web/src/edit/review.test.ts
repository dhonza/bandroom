import type { EditReview } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { reviewView } from "./applyFlow";
import { processingLabel, processingRange, sizeVerdict, timelineParts } from "./review";

describe("review helpers", () => {
  it("shows the processing estimate as a range", () => {
    expect(processingRange(10)).toEqual({ lo: 6, hi: 16 });
    expect(processingRange(0)).toEqual({ lo: 1, hi: 2 });
    expect(processingLabel({ lo: 6, hi: 16 })).toEqual({ unit: "sec", lo: 6, hi: 16 });
    expect(processingLabel(processingRange(300))).toEqual({ unit: "min", lo: 3, hi: 8 });
  });

  it("says whether the new audio fits; the disk wins", () => {
    expect(sizeVerdict({ fitsQuota: true, fitsDisk: true })).toBe("ok");
    expect(sizeVerdict({ fitsQuota: false, fitsDisk: true })).toBe("overQuota");
    expect(sizeVerdict({ fitsQuota: false, fitsDisk: false })).toBe("overDisk");
  });

  it("lists the non-zero timeline changes in reading order", () => {
    expect(
      timelineParts({
        markersMoved: 2,
        markersDeleted: 1,
        sectionsMoved: 0,
        sectionsDeleted: 0,
        commentsMoved: 0,
        commentsEditedOut: 3,
        tempoChanged: true,
      }),
    ).toEqual([
      { key: "markersMoved", count: 2 },
      { key: "markersDeleted", count: 1 },
      { key: "commentsEditedOut", count: 3 },
      { key: "tempo", count: 1 },
    ]);
  });
});

const output = (patch: Partial<EditReview["outputs"][number]>): EditReview["outputs"][number] => ({
  key: "t1",
  trackId: "t1",
  trackName: "Guitar",
  title: "Guitar",
  rangeId: null,
  songTitle: null,
  oldDurationSec: 10,
  durationSec: 9,
  estimatedBytes: 100,
  peakDb: null,
  ...patch,
});

const review = (patch: Partial<EditReview>): EditReview => ({
  kind: "apply",
  rev: 1,
  outputs: [],
  totalBytes: 100,
  quotaRemainingBytes: null,
  diskFreeBytes: 1000,
  fitsQuota: true,
  fitsDisk: true,
  estimatedSec: 3,
  warnings: [],
  remap: null,
  ranges: { sections: [], markers: [] },
  ...patch,
});

describe("reviewView", () => {
  it("lists the edited tracks with old and new length and names the warned tracks", () => {
    const v = reviewView(
      review({
        outputs: [
          output({}),
          output({ key: "t2", trackId: "t2", trackName: "Bass", title: "Bass" }),
        ],
        warnings: [{ code: "LOSSY_SOURCE", trackIds: ["t2", "gone"] }],
      }),
    );
    expect(v.tracks).toEqual([
      { key: "t1", name: "Guitar", oldSec: 10, newSec: 9 },
      { key: "t2", name: "Bass", oldSec: 10, newSec: 9 },
    ]);
    expect(v.warnings).toEqual([{ code: "LOSSY_SOURCE", tracks: ["Bass"] }]);
    expect(v.timeline).toBeNull();
  });

  it("shows one row per new song for a split", () => {
    const v = reviewView(
      review({
        kind: "bounceSongs",
        outputs: [
          output({ key: "r1:t1", rangeId: "r1", songTitle: "Intro", durationSec: 4 }),
          output({ key: "r1:t2", rangeId: "r1", songTitle: "Intro", durationSec: 5 }),
          output({ key: "r2:t1", rangeId: "r2", songTitle: "Verse", durationSec: 6 }),
        ],
      }),
    );
    expect(v.tracks).toEqual([
      { key: "r1", name: "Intro", oldSec: null, newSec: 5 },
      { key: "r2", name: "Verse", oldSec: null, newSec: 6 },
    ]);
  });
});
