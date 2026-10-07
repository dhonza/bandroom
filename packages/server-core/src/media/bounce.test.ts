import { describe, expect, it } from "vitest";
import { BouncePayloadSchema, bounceMixInput } from "./bounce";

const input = { faderDb: -6, versionGainDb: -6, pan: -0.5, offsetSamples: 4800 };

describe("bounceMixInput (SPEC §5.5)", () => {
  it("multiplies fader and version gain, keeps pan and offset", () => {
    const m = bounceMixInput(input, {
      path: "/x.flac",
      variant: "flac",
      probe: { channels: 2, dualMono: false },
    });
    expect(m).toEqual({
      path: "/x.flac",
      gain: expect.closeTo(10 ** (-12 / 20), 9) as number,
      pan: -0.5,
      channels: 2,
      law: "stereo",
      offsetSamples: 4800,
    });
  });

  it("pans true mono with equal power and dual-mono like stereo, reading the stored channels", () => {
    const mono = bounceMixInput(input, {
      path: "m",
      variant: "flac",
      probe: { channels: 1, dualMono: false },
    });
    expect([mono.channels, mono.law]).toEqual([1, "mono"]);
    const dual = { channels: 2, dualMono: true };
    const flac = bounceMixInput(input, { path: "d", variant: "flac", probe: dual });
    expect([flac.channels, flac.law]).toEqual([1, "stereo"]);
    // A kept original of a dual-mono upload still has two channels.
    const orig = bounceMixInput(input, { path: "d", variant: "original", probe: dual });
    expect([orig.channels, orig.law]).toEqual([2, "stereo"]);
    // Without a probe: two channels, balance law.
    const unknown = bounceMixInput(input, { path: "u", variant: "opus", probe: null });
    expect([unknown.channels, unknown.law]).toEqual([2, "stereo"]);
  });
});

describe("BouncePayloadSchema", () => {
  it("needs at least one input with a valid pan and offset", () => {
    const base = {
      assetId: "a",
      projectId: "p",
      songId: "s",
      trackVersionId: "v",
      sourceSongId: "src",
      userId: "u",
    };
    const one = { trackId: "t", versionId: "v", assetId: "a", ...input };
    expect(BouncePayloadSchema.safeParse({ ...base, inputs: [one] }).success).toBe(true);
    expect(BouncePayloadSchema.safeParse({ ...base, inputs: [] }).success).toBe(false);
    expect(
      BouncePayloadSchema.safeParse({ ...base, inputs: [{ ...one, offsetSamples: -1 }] }).success,
    ).toBe(false);
  });
});
