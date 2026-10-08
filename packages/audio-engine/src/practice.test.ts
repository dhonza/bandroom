import { describe, expect, it } from "vitest";
import {
  isNeutralPractice,
  mixerClips,
  NEUTRAL_PRACTICE,
  playbackLength,
  samePractice,
  toPlayback,
  toTimeline,
  workerStretch,
} from "./practice";
import type { EngineClip } from "./types";

const clip: EngineClip = {
  startFrame: 1000,
  sourceOffsetFrame: 0,
  lengthFrames: 5000,
  variant: {
    kind: "opus",
    hash: "h",
    url: "u",
    seekIndexUrl: null,
    channels: 1,
    preSkip: 312,
    totalFrames: 5000,
    sampleRate: 48_000,
  },
};
const slow = { rate: 0.5, semitones: 0, quality: "high" } as const;
const down = { rate: 1, semitones: -2, quality: "economy" } as const;
const drums = {
  transpose: false,
  profile: "percussive",
  voiceBaseHz: 0,
  formant: false,
  formantShift: 0,
} as const;

describe("practice time model", () => {
  it("converts between timeline and playback frames", () => {
    expect(playbackLength(48_000, 0.75)).toBe(64_000);
    expect(playbackLength(10, 0.3)).toBe(34);
    expect(toPlayback(300, 0.75)).toBe(400);
    expect(toPlayback(301, 1)).toBe(301);
    expect(toTimeline(400, 0.75)).toBe(300);
    expect(toTimeline(7, 1)).toBe(7);
  });

  it("knows a neutral and an equal setting", () => {
    expect(isNeutralPractice(NEUTRAL_PRACTICE)).toBe(true);
    expect(isNeutralPractice({ ...NEUTRAL_PRACTICE, quality: "economy" })).toBe(true);
    expect(isNeutralPractice(slow)).toBe(false);
    expect(isNeutralPractice(down)).toBe(false);
    expect(samePractice(slow, { ...slow })).toBe(true);
    expect(samePractice(slow, { ...slow, quality: "economy" })).toBe(false);
  });
});

describe("workerStretch", () => {
  it("plays every track as is without practice", () => {
    expect(workerStretch(NEUTRAL_PRACTICE, undefined, true, [clip], 9000)).toBeNull();
  });

  it("transposes by default and keeps drums at their pitch", () => {
    expect(workerStretch(down, undefined, false, [clip], 9000)).toEqual({
      rate: 1,
      semitones: -2,
      profile: "tonal",
      quality: "economy",
      voiceBaseHz: 0,
      formant: false,
      formantShift: 0,
      channels: 1,
      silent: false,
      timelineFrames: 9000,
    });
    // At 100 % a track kept at its pitch needs no stretcher at all.
    expect(workerStretch(down, drums, false, [clip], 9000)).toBeNull();
    expect(workerStretch(slow, drums, false, [clip], 9000)).toMatchObject({
      rate: 0.5,
      semitones: 0,
      profile: "percussive",
    });
  });

  it("silences muted tracks instead of stretching them", () => {
    expect(workerStretch(down, drums, true, [], 9000)).toMatchObject({
      silent: true,
      channels: 2,
    });
  });

  it("processes a formant shift alone, even at 100 % and 0 st", () => {
    const voice = { transpose: true, profile: "voice", voiceBaseHz: 100, formant: true } as const;
    expect(
      workerStretch(NEUTRAL_PRACTICE, { ...voice, formantShift: 0 }, false, [clip], 9000),
    ).toBeNull();
    expect(
      workerStretch(NEUTRAL_PRACTICE, { ...voice, formantShift: 3 }, false, [clip], 9000),
    ).toMatchObject({ rate: 1, semitones: 0, formant: true, formantShift: 3, silent: false });
    // A muted track with a shift plays silence; without one it plays as is.
    expect(
      workerStretch(NEUTRAL_PRACTICE, { ...voice, formantShift: 3 }, true, [clip], 9000),
    ).toMatchObject({ silent: true });
    expect(
      workerStretch(NEUTRAL_PRACTICE, { ...voice, formantShift: 0 }, true, [clip], 9000),
    ).toBeNull();
  });

  it("gives stretched tracks data over the whole song", () => {
    const s = workerStretch(slow, undefined, false, [clip], 9000);
    expect(mixerClips([clip], s, 18_000)).toEqual([{ start: 0, end: 18_000 }]);
    expect(mixerClips([clip], null, 9000)).toEqual([{ start: 1000, end: 6000 }]);
  });
});
