import type { TrackVersion } from "@bandroom/shared";
import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { opusRate, storedQuality } from "./audioFormat";

type V = Pick<TrackVersion, "media" | "variants" | "archived">;

const media = (over: Partial<NonNullable<TrackVersion["media"]>> = {}) => ({
  durationSec: 10,
  sampleRate: 48_000,
  channels: 2,
  bitDepth: 24,
  codec: "pcm_s24le",
  lossless: true,
  dualMono: false,
  integratedLufs: null,
  truePeakDbtp: null,
  ...over,
});

const opus = (bitrate: number, channels: number) => ({
  hash: "a",
  bitrate,
  channels,
  preSkip: 312,
  durationSamples48k: 480_000,
});

const flac = (over: Partial<NonNullable<TrackVersion["variants"]["flac"]>> = {}) => ({
  hash: "b",
  sampleRate: 48_000,
  bitDepth: 24,
  channels: 2,
  durationSamples: 480_000,
  nearLossless: false,
  ...over,
});

function version(
  over: Partial<Omit<V, "variants">> & { variants?: Partial<V["variants"]> } = {},
): V {
  return {
    media: over.media === undefined ? media() : over.media,
    archived: over.archived ?? null,
    variants: {
      opus: opus(96, 2),
      opusLow: null,
      flac: flac(),
      peaks: null,
      seekIndex: { opus: null, opusLow: null, flac: null },
      ...over.variants,
    },
  };
}

const en = i18next.createInstance();
const cs = i18next.createInstance();

describe("storedQuality", () => {
  beforeAll(async () => {
    await initI18n("en", en);
    await initI18n("cs", cs);
  });

  it("full quality: FLAC details plus the Opus copy", () => {
    expect(storedQuality(version(), en.t)).toBe("FLAC 24-bit 48 kHz + Opus 96 kbps stereo");
    expect(storedQuality(version(), cs.t)).toBe("FLAC 24 bitů 48 kHz + Opus 96 kb/s stereo");
  });

  it("dual mono: the mono Opus copy", () => {
    const v = version({
      media: media({ channels: 1, dualMono: true }),
      variants: { opus: opus(64, 1), flac: flac({ channels: 1 }) },
    });
    expect(storedQuality(v, en.t)).toBe("FLAC 24-bit 48 kHz + Opus 64 kbps mono");
    expect(storedQuality(v, cs.t)).toBe("FLAC 24 bitů 48 kHz + Opus 64 kb/s mono");
  });

  it("44.1 kHz and a float source (near-lossless FLAC)", () => {
    const v = version({
      media: media({ sampleRate: 44_100, bitDepth: 32 }),
      variants: { flac: flac({ sampleRate: 44_100, nearLossless: true }) },
    });
    expect(storedQuality(v, en.t)).toBe("FLAC 24-bit 44.1 kHz (from float) + Opus 96 kbps stereo");
  });

  it("a viewer who may not download: the FLAC facts come from the media", () => {
    const v = version({ media: media({ sampleRate: 96_000 }), variants: { flac: null } });
    expect(storedQuality(v, en.t)).toBe("FLAC 24-bit 96 kHz + Opus 96 kbps stereo");
    const noBits = version({ media: media({ bitDepth: 0 }), variants: { flac: null } });
    expect(storedQuality(noBits, en.t)).toBe("FLAC 48 kHz + Opus 96 kbps stereo");
  });

  it("lossy: the Opus copy and why", () => {
    const archived = (reason: "removed" | "upload" | "reencode") => ({
      at: 0,
      by: null,
      reason,
    });
    const lossy = (a: V["archived"], m = media()) =>
      storedQuality(
        version({ media: m, archived: a, variants: { opus: opus(128, 2), flac: null } }),
        en.t,
      );
    expect(lossy(null, media({ lossless: false, codec: "mp3" }))).toBe(
      "Opus 128 kbps stereo (lossy source)",
    );
    expect(lossy(archived("upload"))).toBe("Opus 128 kbps stereo (converted on upload)");
    expect(lossy(archived("reencode"))).toBe("Opus 128 kbps stereo (re-encoded)");
    expect(lossy(archived("removed"))).toBe("Opus 128 kbps stereo (full quality removed)");
    expect(
      storedQuality(
        version({ archived: archived("upload"), variants: { opus: opus(128, 2), flac: null } }),
        cs.t,
      ),
    ).toBe("Opus 128 kb/s stereo (převedeno při nahrání)");
  });

  it("nothing stored yet", () => {
    expect(
      storedQuality(version({ media: null, variants: { opus: null, flac: null } }), en.t),
    ).toBe(null);
  });

  it("opusRate", () => {
    expect(opusRate(en.t, 80, 1)).toBe("80 kbps mono");
    expect(opusRate(en.t, 128, 2)).toBe("128 kbps stereo");
  });
});
