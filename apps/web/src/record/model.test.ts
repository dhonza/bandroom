import { describe, expect, it } from "vitest";
import {
  clampInputGain,
  clampNudge,
  estimateTakeBytes,
  formatOffset,
  formatTakeTime,
  maxTakeMinutesFor,
  meterPercent,
  minutesThatFit,
  nextRecordingName,
  takeOffsetSamples,
} from "./model";

describe("takeOffsetSamples", () => {
  it("places the take at start − latency, later by a positive nudge", () => {
    const m = { startFrame: 96_000, trimmedFrames: 0, latencyFrames: 1_200 };
    expect(takeOffsetSamples(m, 0)).toBe(94_800);
    expect(takeOffsetSamples(m, 10)).toBe(95_280);
    expect(takeOffsetSamples(m, -1)).toBe(94_752);
  });

  it("starts a take trimmed at the song start at 0 (moved later by the nudge)", () => {
    const m = { startFrame: 0, trimmedFrames: 1_200, latencyFrames: 1_200 };
    expect(takeOffsetSamples(m, 0)).toBe(0);
    expect(takeOffsetSamples(m, 5)).toBe(240);
    expect(takeOffsetSamples(m, -5)).toBe(0);
  });
});

describe("helpers", () => {
  it("names the next recording", () => {
    expect(nextRecordingName("Recording", [])).toBe("Recording 1");
    expect(nextRecordingName("Recording", ["Bass", "recording 2", "Recording 7x"])).toBe(
      "Recording 3",
    );
    expect(nextRecordingName("Nahrávka", ["Nahrávka 9"])).toBe("Nahrávka 10");
  });

  it("clamps the nudge", () => {
    expect(clampNudge(12.4)).toBe(12);
    expect(clampNudge(99_999)).toBe(2000);
    expect(clampNudge(Number.NaN)).toBe(0);
  });

  it("estimates take sizes", () => {
    // 1 min stereo: 60 × 48 000 × 2 × 3 B × 0.6 × 1.1.
    expect(estimateTakeBytes(1, 2)).toBe(Math.ceil(60 * 48_000 * 2 * 3 * 0.66));
    expect(minutesThatFit(estimateTakeBytes(10, 1) + 5, 1)).toBe(10);
    expect(minutesThatFit(-5, 1)).toBe(0);
    // Float: 4 bytes per sample, no compression.
    expect(estimateTakeBytes(1, 2, "wav32f")).toBe(60 * 48_000 * 2 * 4);
    expect(minutesThatFit(estimateTakeBytes(10, 2, "wav32f") + 5, 2, "wav32f")).toBe(10);
    expect(minutesThatFit(estimateTakeBytes(10, 2, "wav32f"), 2)).toBeGreaterThan(10);
  });

  it("caps float takes at what fits in a WAV file", () => {
    expect(maxTakeMinutesFor(240, 2, "flac")).toBe(240);
    expect(maxTakeMinutesFor(240, 2, "wav32f")).toBe(186);
    expect(maxTakeMinutesFor(240, 1, "wav32f")).toBe(240);
    expect(maxTakeMinutesFor(600, 1, "wav32f")).toBe(372);
  });

  it("formats times and levels", () => {
    expect(formatTakeTime(48_000 * 75.9)).toBe("1:15");
    expect(formatTakeTime(48_000 * 3725)).toBe("1:02:05");
    expect(formatOffset(48_000 * 62.5)).toBe("1:02.500");
    expect(meterPercent(0)).toBe(0);
    expect(meterPercent(1)).toBe(100);
    expect(meterPercent(0.001)).toBe(0);
    expect(Math.round(meterPercent(0.1))).toBe(67);
  });
});

describe("clampInputGain", () => {
  it("keeps the gain within 0…40 dB", () => {
    expect(clampInputGain(12.5)).toBe(12.5);
    expect(clampInputGain(-3)).toBe(0);
    expect(clampInputGain(55)).toBe(40);
    expect(clampInputGain(Number.NaN)).toBe(0);
    expect(clampInputGain(6.0001)).toBe(6);
  });
});
