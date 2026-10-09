import { describe, expect, it } from "vitest";
import {
  latencyFrames,
  looksLikeBluetooth,
  msToFrames,
  placeTake,
  QUANTUM_FRAMES,
} from "./placement";

describe("take placement (SPEC §9)", () => {
  it("adds output, input and one render quantum", () => {
    expect(latencyFrames({ outputSec: 0.01, inputSec: 0.005 })).toBe(720 + QUANTUM_FRAMES);
    expect(latencyFrames({ outputSec: 0, inputSec: 0 })).toBe(128);
    // Nonsense reports count as zero.
    expect(latencyFrames({ outputSec: -1, inputSec: Number.NaN })).toBe(128);
  });

  it("moves the take earlier by the latency", () => {
    expect(placeTake(96_000, 848)).toEqual({ offsetSamples: 95_152, trimHead: 0 });
  });

  it("trims the head instead of a negative offset", () => {
    expect(placeTake(0, 848)).toEqual({ offsetSamples: 0, trimHead: 848 });
    expect(placeTake(500, 848)).toEqual({ offsetSamples: 0, trimHead: 348 });
    expect(placeTake(848, 848)).toEqual({ offsetSamples: 0, trimHead: 0 });
  });

  it("applies the nudge: positive moves the take later", () => {
    expect(placeTake(96_000, 848, msToFrames(10))).toEqual({ offsetSamples: 95_632, trimHead: 0 });
    expect(placeTake(96_000, 848, -msToFrames(1))).toEqual({ offsetSamples: 95_104, trimHead: 0 });
    expect(placeTake(0, 848, msToFrames(100))).toEqual({ offsetSamples: 3952, trimHead: 0 });
    expect(placeTake(0, 0, -48)).toEqual({ offsetSamples: 0, trimHead: 48 });
  });

  it("warns about Bluetooth by device name or a latency over 100 ms", () => {
    const low = { outputSec: 0.02, inputSec: 0.01 };
    expect(looksLikeBluetooth(["MacBook Pro Microphone"], low)).toBe(false);
    expect(looksLikeBluetooth(["Jan's AirPods Pro"], low)).toBe(true);
    expect(looksLikeBluetooth(["Galaxy Buds2"], low)).toBe(true);
    expect(looksLikeBluetooth(["Headset (Hands-Free)"], low)).toBe(true);
    expect(looksLikeBluetooth(["WH-1000XM4"], low)).toBe(true);
    expect(looksLikeBluetooth(["External Microphone"], { outputSec: 0.09, inputSec: 0.02 })).toBe(
      true,
    );
    expect(looksLikeBluetooth([], { outputSec: 0.1, inputSec: 0 })).toBe(false);
  });

  it("converts milliseconds to frames at 48 kHz", () => {
    expect(msToFrames(1)).toBe(48);
    expect(msToFrames(-10)).toBe(-480);
    expect(msToFrames(0.5)).toBe(24);
  });
});
