import { describe, expect, it } from "vitest";
import { opusKbps, qualityForKbps, UploadOptionsSchema } from "./audioQuality";

describe("Opus quality presets (SPEC §28.2)", () => {
  it("maps presets to stereo and mono bitrates; standard follows the setting", () => {
    expect(opusKbps("veryHigh", false)).toBe(160);
    expect(opusKbps("high", true)).toBe(80);
    expect(opusKbps("standard", false)).toBe(96);
    expect(opusKbps("low", true)).toBe(48);
    expect(opusKbps("standard", true, { stereo: 112, mono: 72 })).toBe(72);
  });

  it("finds the preset of a bitrate", () => {
    expect(qualityForKbps(128, false)).toBe("high");
    expect(qualityForKbps(64, true)).toBe("standard");
    expect(qualityForKbps(64, false)).toBe("low");
    expect(qualityForKbps(100, false)).toBeNull();
    expect(qualityForKbps(112, false, { stereo: 112, mono: 72 })).toBe("standard");
  });

  it("defaults the upload options to keeping full quality at the standard preset", () => {
    expect(UploadOptionsSchema.parse({})).toEqual({ lossyOnly: false, quality: "standard" });
    expect(UploadOptionsSchema.safeParse({ quality: "ultra" }).success).toBe(false);
  });
});
