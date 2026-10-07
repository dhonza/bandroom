import type { Marker, SongTempo } from "@bandroom/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  endTempoPreview,
  previewTempo,
  resetTempoUiForTests,
  setSongTempo,
  useTempoUi,
} from "../tempo/store";
import {
  anchorNow,
  cycleSnap,
  nudgeBy,
  setSnap,
  clearSelection,
  goNext,
  goPrev,
  loopSection,
  playPause,
  registerPlayer,
  resetTimelineUiForTests,
  returnToStart,
  setDragging,
  setMarkers,
  setSelection,
  toggleLoop,
  useTimelineUi,
  type PlayerAdapter,
} from "./store";

const section = (id: string, startSec: number, endSec: number): Marker => ({
  id,
  songId: "s",
  type: "section",
  name: id,
  color: "red",
  note: "",
  startSec,
  endSec,
  anchor: "time",
  startBeat: null,
  endBeat: null,
  lane: 0,
  createdBy: null,
  createdByName: null,
  createdAt: 0,
  updatedAt: 0,
});

function fakePlayer() {
  const p = {
    pos: 0,
    playing: false,
    loops: [] as ({ start: number; end: number } | null)[],
  };
  const adapter: PlayerAdapter = {
    mode: "rehearse",
    position: () => p.pos,
    duration: () => 100,
    seek: (s) => {
      p.pos = s;
    },
    setLoop: (r) => p.loops.push(r),
    togglePlay: () => {
      p.playing = !p.playing;
    },
    isPlaying: () => p.playing,
  };
  return { p, adapter };
}

beforeEach(() => {
  resetTimelineUiForTests();
});

describe("timeline store (SPEC §7.6)", () => {
  it("loops the section under the playhead and follows the selection", () => {
    const { p, adapter } = fakePlayer();
    registerPlayer(adapter);
    setMarkers([section("a", 10, 20), section("b", 20, 30)]);
    expect(toggleLoop()).toBe(false); // playhead at 0: nothing to loop
    p.pos = 12;
    expect(toggleLoop()).toBe(true);
    expect(p.loops.at(-1)).toEqual({ start: 10, end: 20 });
    // Dragging the selection moves the loop when the drag ends.
    setDragging(true);
    setSelection({ start: 11, end: 19 });
    expect(p.loops.at(-1)).toEqual({ start: 10, end: 20 });
    setDragging(false);
    expect(p.loops.at(-1)).toEqual({ start: 11, end: 19 });
    clearSelection();
    expect(p.loops.at(-1)).toBeNull();
    expect(useTimelineUi.getState().loopOn).toBe(false);
  });

  it("double tap loops a section and jumps into it; Enter returns to the loop start", () => {
    const { p, adapter } = fakePlayer();
    registerPlayer(adapter);
    const b = section("b", 20, 30);
    setMarkers([section("a", 10, 20), b]);
    loopSection(b);
    expect(p.pos).toBe(20);
    p.pos = 25;
    returnToStart();
    expect(p.pos).toBe(20);
    returnToStart(); // second press: song start
    expect(p.pos).toBe(0);
  });

  it("navigates boundaries and remembers the play start", () => {
    const { p, adapter } = fakePlayer();
    registerPlayer(adapter);
    setMarkers([section("a", 10, 20)]);
    p.pos = 5;
    playPause();
    expect(useTimelineUi.getState().lastPlayStart).toBe(5);
    goNext();
    expect(p.pos).toBe(10);
    goNext();
    expect(p.pos).toBe(20);
    p.pos = 20.2; // playing: within 0.5 s of a boundary goes one further back
    goPrev();
    expect(p.pos).toBe(10);
  });
});

describe("musical timeline actions (SPEC §7.4–§7.6, M7)", () => {
  const tempo = (bpm: number): SongTempo => ({
    map: { segments: [{ startBeat: 0, bpm, meter: { num: 4, den: 4 }, barIndex: 0 }] },
    bar1OffsetSec: 0,
    source: "manual",
    midiFileName: null,
    revisionId: `r${bpm}`,
    updatedByName: null,
    updatedAt: 0,
  });

  beforeEach(() => {
    resetTempoUiForTests();
  });

  it("nudges by beats and bars with a tempo map and cycles musical snap modes", () => {
    const { p, adapter } = fakePlayer();
    registerPlayer(adapter);
    p.pos = 10.2;
    nudgeBy(1, false);
    expect(p.pos).toBe(11.2); // no tempo: 1 s
    expect(cycleSnap()).toBe("off"); // markers → off (no musical modes yet)
    setSongTempo("s", tempo(120));
    nudgeBy(1, false);
    expect(p.pos).toBe(11.5); // next beat
    nudgeBy(-1, true);
    expect(p.pos).toBe(10); // previous bar line
    setSnap("markers");
    expect(cycleSnap()).toBe("bar");
    expect(anchorNow()).toBe("musical");
    expect(anchorNow("time")).toBe("musical");
    setSnap("markers");
    expect(anchorNow()).toBe("time");
    expect(anchorNow("musical")).toBe("musical");
  });

  it("previews a draft tempo and falls back to the saved one", () => {
    setSongTempo("s", tempo(120));
    const saved = useTempoUi.getState().grid;
    previewTempo("s", tempo(90));
    setSongTempo("s", tempo(100)); // server update during the preview is kept for later
    expect(useTempoUi.getState().tempo?.revisionId).toBe("r90");
    endTempoPreview();
    expect(useTempoUi.getState().tempo?.revisionId).toBe("r100");
    expect(useTempoUi.getState().grid).not.toBe(saved);
    endTempoPreview(); // no-op
    setSongTempo("s", null);
    expect(useTempoUi.getState().grid).toBeNull();
  });
});
