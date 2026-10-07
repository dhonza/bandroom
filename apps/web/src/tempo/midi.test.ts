import { MANUAL_MAX_BPM, MANUAL_MIN_BPM } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import {
  clampManualBpm,
  midiWarningKey,
  offsetFromInput,
  roundMs,
  tempoSummaryParams,
  toggled,
} from "./midi";

describe("MIDI import warnings", () => {
  it("maps each warning to its key and parameters", () => {
    expect(midiWarningKey({ code: "meterRounded", bar: 3 })).toEqual({
      key: "tempo.midi.warnings.meterRounded",
      params: { bar: 3 },
    });
    expect(midiWarningKey({ code: "tempoClamped", bpm: 1000 })).toEqual({
      key: "tempo.midi.warnings.tempoClamped",
      params: { bpm: 1000 },
    });
    expect(midiWarningKey({ code: "tooManyMarkers", count: 500 })).toEqual({
      key: "tempo.midi.warnings.tooManyMarkers",
      params: { count: 500 },
    });
    expect(midiWarningKey({ code: "noTempo" })).toEqual({
      key: "tempo.midi.warnings.noTempo",
      params: {},
    });
  });
});

describe("tempo dialog helpers", () => {
  it("formats the summary parameters", () => {
    expect(
      tempoSummaryParams({ bpmMin: 96, bpmMax: 128.04, meters: ["4/4", "3/4"], changes: 2 }),
    ).toEqual({ bpm: "96–128", meter: "4/4, 3/4" });
  });

  it("clamps tapped tempos and rounds offsets to milliseconds", () => {
    expect(clampManualBpm(1)).toBe(MANUAL_MIN_BPM);
    expect(clampManualBpm(100000)).toBe(MANUAL_MAX_BPM);
    expect(clampManualBpm(120)).toBe(120);
    expect(roundMs(1.23456)).toBe(1.235);
    expect(roundMs(0.1 + 0.2)).toBe(0.3);
  });

  it("reads the offset input", () => {
    expect(offsetFromInput(1.5)).toBe(1.5);
    expect(offsetFromInput("2.25")).toBe(2.25);
    expect(offsetFromInput("")).toBe(0);
    expect(offsetFromInput("-")).toBe(0);
  });

  it("toggles a picked index without changing the original set", () => {
    const a = new Set([1, 2]);
    expect([...toggled(a, 2)]).toEqual([1]);
    expect([...toggled(a, 3)]).toEqual([1, 2, 3]);
    expect([...a]).toEqual([1, 2]);
  });
});
