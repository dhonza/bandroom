import type { MixerTrackState, Track, TrackVersion } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import {
  abPartner,
  buildTimeline,
  chooseVariant,
  defaultMix,
  dimmedTrackIds,
  loudnessOffsetDb,
  clickSettingsOf,
  changedTrims,
  loadKeyOf,
  mergeMix,
  mergeSnapshot,
  myInstrumentTracks,
  playableTracks,
  recoveredErrors,
  resetMix,
  resolveQuality,
  toggleMyInstrument,
  type QualityEnv,
} from "./model";

const url = (h: string) => `/blobs/${h}`;

function version(over: Partial<TrackVersion> = {}, flac = true): TrackVersion {
  return {
    id: "v1",
    number: 1,
    label: "",
    notes: "",
    offsetSamples: 0,
    gainDb: 0,
    source: "upload",
    createdAt: 0,
    uploadedBy: null,
    uploaderName: null,
    originalFilename: "a.wav",
    sizeBytes: 1,
    status: "ready",
    error: null,
    archived: null,
    progress: null,
    media: null,
    variants: {
      opus: { hash: "o", bitrate: 96, channels: 2, preSkip: 312, durationSamples48k: 480_000 },
      opusLow: { hash: "l", bitrate: 32, channels: 2, preSkip: 312, durationSamples48k: 480_000 },
      flac: flac
        ? {
            hash: "f",
            sampleRate: 44_100,
            bitDepth: 24,
            channels: 2,
            durationSamples: 441_000,
            nearLossless: false,
          }
        : null,
      peaks: null,
      seekIndex: { opus: "io", opusLow: null, flac: "if" },
    },
    downloads: [],
    ...over,
  };
}

function track(id: string, over: Partial<Track> = {}): Track {
  return {
    id,
    songId: "s",
    name: id,
    color: "blue",
    sortOrder: 0,
    instrumentTag: "",
    defaultGainDb: 0,
    defaultPan: 0,
    defaultMuted: false,
    versionCount: 1,
    createdBy: null,
    current: version({ id: `${id}-v1` }),
    ...over,
  };
}

const env = (over: Partial<QualityEnv> = {}): QualityEnv => ({
  phone: false,
  saveData: false,
  slow: false,
  downlinkMbps: null,
  audibleTracks: 8,
  preferLossless: false,
  ...over,
});

describe("quality (SPEC §6.9)", () => {
  it("resolves auto from the device and connection", () => {
    expect(resolveQuality("auto", env())).toBe("high");
    expect(resolveQuality("auto", env({ preferLossless: true }))).toBe("lossless");
    expect(resolveQuality("auto", env({ preferLossless: true, phone: true }))).toBe("high");
    expect(resolveQuality("auto", env({ saveData: true }))).toBe("low");
    expect(resolveQuality("auto", env({ slow: true }))).toBe("low");
    expect(resolveQuality("auto", env({ downlinkMbps: 2, audibleTracks: 8 }))).toBe("low"); // 250 kbit/s each
    expect(resolveQuality("auto", env({ downlinkMbps: 10, audibleTracks: 8 }))).toBe("high");
    expect(resolveQuality("low", env({ preferLossless: true }))).toBe("low");
  });

  it("picks the variant and falls back when FLAC is missing", () => {
    const flac = chooseVariant(version(), "lossless", url);
    expect(flac?.quality).toBe("lossless");
    expect(flac?.variant).toMatchObject({
      kind: "flac",
      url: "/blobs/f",
      seekIndexUrl: "/blobs/if",
      sampleRate: 44_100,
      totalFrames: 441_000,
    });
    expect(chooseVariant(version({}, false), "lossless", url)?.quality).toBe("high");
    const low = chooseVariant(version(), "low", url);
    expect(low?.variant).toMatchObject({ kind: "opus", hash: "l", seekIndexUrl: null });
    const v = version();
    v.variants.opus = null;
    expect(chooseVariant(v, "high", url)?.quality).toBe("low");
    v.variants.opusLow = null;
    expect(chooseVariant(v, "high", url)).toBeNull();
  });

  it("tells the engine about dual-mono sources (SPEC §6.6)", () => {
    expect(chooseVariant(version(), "high", url)?.variant.dualMono).toBe(false);
    const media = {
      durationSec: 10,
      sampleRate: 44_100,
      channels: 2,
      bitDepth: 24,
      codec: "pcm_s24le",
      lossless: true,
      dualMono: true,
      integratedLufs: null,
      truePeakDbtp: null,
    };
    expect(chooseVariant(version({ media }), "high", url)?.variant.dualMono).toBe(true);
    expect(chooseVariant(version({ media }), "lossless", url)?.variant.dualMono).toBe(true);
  });
});

describe("version gain (SPEC §25.6)", () => {
  it("goes to the engine as trim and only changed gains are re-applied", () => {
    const before = playableTracks(
      [track("a"), track("b", { current: version({ id: "b1", gainDb: 2 }) })],
      {},
      "high",
      url,
    );
    expect(buildTimeline(before, defaultMix([])).tracks.map((t) => t.trimDb)).toEqual([0, 2]);
    const after = playableTracks(
      [
        track("a", { current: version({ gainDb: -6 }) }),
        track("b", { current: version({ id: "b1", gainDb: 2 }) }),
        track("c"),
      ],
      {},
      "high",
      url,
    );
    expect(changedTrims(before, after)).toEqual([
      { trackId: "a", trimDb: -6 },
      { trackId: "c", trimDb: 0 },
    ]);
    expect(changedTrims(after, after)).toEqual([]);
  });
});

describe("timeline", () => {
  it("uses listened versions and offsets, and skips tracks without ready audio", () => {
    const tracks = [
      track("a"),
      track("b", { current: version({ id: "b1", offsetSamples: 48_000 }) }),
      track("c", { current: version({ id: "c1", status: "processing" }) }),
      track("d", { current: null }),
    ];
    const listened = { a: version({ id: "a2", offsetSamples: -100 }) };
    const playable = playableTracks(tracks, listened, "high", url);
    expect(playable.map((p) => p.version.id)).toEqual(["a2", "b1"]);
    const mix = defaultMix(tracks);
    const a = mix.tracks.a;
    if (a) a.gainDb = -6;
    const tl = buildTimeline(playable, mix);
    expect(tl.tracks.map((t) => [t.id, t.gainDb, t.clips[0]?.startFrame])).toEqual([
      ["a", -6, -100],
      ["b", 0, 48_000],
    ]);
    expect(tl.lengthFrames).toBe(48_000 + 480_000);
    // FLAC at 44.1 kHz: clip length in 48 kHz frames.
    const lossless = buildTimeline(
      playableTracks([track("x")], {}, "lossless", url),
      defaultMix([]),
    );
    expect(lossless.tracks[0]?.clips[0]?.lengthFrames).toBe(480_000);
  });
});

describe("mix state", () => {
  it("starts from track defaults (no roles, SPEC §27)", () => {
    const tracks = [
      track("a", { defaultGainDb: -3, defaultPan: 0.5, defaultMuted: true }),
      track("m"),
    ];
    expect(defaultMix(tracks).tracks).toEqual({
      a: { gainDb: -3, pan: 0.5, mute: true, solo: false, listenedVersionId: null },
      m: { gainDb: 0, pan: 0, mute: false, solo: false, listenedVersionId: null },
    });
  });

  it("merges saved state, resets while keeping listened versions", () => {
    const tracks = [track("a"), track("b")];
    const saved = {
      tracks: {
        a: { gainDb: -10, pan: 0, mute: false, solo: true, listenedVersionId: "old" },
        gone: { gainDb: 0, pan: 0, mute: true, solo: false },
      },
    };
    const merged = mergeMix(tracks, saved);
    expect(Object.keys(merged.tracks)).toEqual(["a", "b"]);
    expect(merged.tracks.a).toMatchObject({ gainDb: -10, solo: true });
    expect(mergeMix(tracks, null)).toEqual(defaultMix(tracks));
    expect(resetMix(tracks, merged).tracks.a).toEqual({
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      listenedVersionId: "old",
    });
  });

  it("keeps the personal click settings across merge and reset (SPEC §4.4 click)", () => {
    const tracks = [track("a")];
    const merged = mergeMix(tracks, { tracks: {}, click: { enabled: true, countInBars: 2 } });
    expect(clickSettingsOf(merged)).toMatchObject({
      enabled: true,
      countInBars: 2,
      sound: "woodblock",
      countIn: false,
    });
    expect(resetMix(tracks, merged).click).toEqual({ enabled: true, countInBars: 2 });
    expect(clickSettingsOf(defaultMix(tracks)).enabled).toBe(false);
  });

  it("mutes and unmutes my instrument", () => {
    const tracks = [
      track("a", { instrumentTag: "Bass " }),
      track("b", { instrumentTag: "drums" }),
      track("c", { instrumentTag: "bass" }),
    ];
    const ids = myInstrumentTracks(tracks, " bass");
    expect(ids).toEqual(["a", "c"]);
    expect(myInstrumentTracks(tracks, "")).toEqual([]);
    const mix = defaultMix(tracks);
    const muted = toggleMyInstrument(mix, ids);
    expect([muted.tracks.a?.mute, muted.tracks.b?.mute, muted.tracks.c?.mute]).toEqual([
      true,
      false,
      true,
    ]);
    expect(toggleMyInstrument(muted, ids).tracks.a?.mute).toBe(false);
    expect(toggleMyInstrument(mix, [])).toBe(mix);
  });

  it("turns the louder A/B version down to the quieter one", () => {
    expect(loudnessOffsetDb(-10, -14)).toBe(-4);
    expect(loudnessOffsetDb(-14, -10)).toBe(0);
    expect(loudnessOffsetDb(null, -10)).toBe(0);
  });
});

describe("dimmedTrackIds", () => {
  it("lists muted tracks and, with a solo, the unsoloed ones; faders do not matter", () => {
    const s = (over: Partial<MixerTrackState> = {}): MixerTrackState => ({
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      listenedVersionId: null,
      ...over,
    });
    expect(dimmedTrackIds({ tracks: { b: s({ mute: true }), a: s() } })).toEqual(["b"]);
    expect(
      dimmedTrackIds({ tracks: { c: s({ solo: true }), b: s({ gainDb: -6 }), a: s() } }),
    ).toEqual(["a", "b"]);
    expect(dimmedTrackIds({ tracks: { a: s({ gainDb: -20, pan: 0.5 }) } })).toEqual([]);
  });
});

describe("controller helpers", () => {
  it("keys the loaded audio by song, versions, files and offsets", () => {
    const playable = playableTracks([track("a"), track("b")], {}, "high", url);
    const key = loadKeyOf("s", playable);
    expect(key).toBe(loadKeyOf("s", playableTracks([track("a"), track("b")], {}, "high", url)));
    expect(loadKeyOf("s2", playable)).not.toBe(key);
    expect(loadKeyOf("s", playableTracks([track("a"), track("b")], {}, "low", url))).not.toBe(key);
    const moved = track("a", { current: version({ id: "a-v1", offsetSamples: 48 }) });
    expect(loadKeyOf("s", playableTracks([moved, track("b")], {}, "high", url))).not.toBe(key);
  });

  it("applies a snapshot's levels but keeps listened versions", () => {
    const mix = defaultMix([track("a"), track("b")]);
    const a = mix.tracks.a;
    if (!a) throw new Error("fixture");
    mix.tracks.a = { ...a, listenedVersionId: "old" };
    const snap = {
      tracks: {
        a: { gainDb: -6, pan: 0.5, mute: true, solo: false, listenedVersionId: "x" },
        gone: { gainDb: 3, pan: 0, mute: false, solo: true, listenedVersionId: null },
      },
    };
    const out = mergeSnapshot(mix, snap);
    expect(out.tracks.a).toEqual({
      gainDb: -6,
      pan: 0.5,
      mute: true,
      solo: false,
      listenedVersionId: "old",
    });
    expect(out.tracks.b).toEqual(mix.tracks.b);
    expect(out.tracks.gone).toBeUndefined();
  });

  it("clears errors of tracks that buffer again", () => {
    expect(recoveredErrors({}, { a: 1 })).toBeNull();
    expect(recoveredErrors({ a: "x" }, { a: 0 })).toBeNull();
    expect(recoveredErrors({ a: "x", b: "y" }, { a: 2 })).toEqual({ b: "y" });
  });

  it("flips an A/B pair", () => {
    expect(abPartner({ a: "1", b: "2" }, "1")).toBe("2");
    expect(abPartner({ a: "1", b: "2" }, "2")).toBe("1");
    expect(abPartner({ a: "1", b: "2" }, "3")).toBe("1");
  });
});
