import type { Instrument, Track, TrackVersion } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import {
  abPartner,
  buildTimeline,
  chooseVariant,
  defaultMix,
  loudnessOffsetDb,
  clickSettingsOf,
  changedTrims,
  enginePracticeOf,
  loadKeyOf,
  mergeMix,
  mergeSnapshot,
  myInstrumentTracks,
  playableTracks,
  recoveredErrors,
  resetMix,
  resolveQuality,
  stretchPolicyOf,
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
    instrument: null,
    transpose: null,
    voiceRange: null,
    formantMode: null,
    formantShift: 0,
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

  it("keeps the practice setting across merge and reset (SPEC §30.2)", () => {
    const tracks = [track("a")];
    const merged = mergeMix(tracks, { tracks: {}, practice: { rate: 0.85, semitones: -2 } });
    expect(merged.practice).toEqual({ rate: 0.85, semitones: -2 });
    expect(resetMix(tracks, merged).practice).toEqual({ rate: 0.85, semitones: -2 });
    expect(defaultMix(tracks).practice).toBeUndefined();
  });

  it("mutes and unmutes my instrument", () => {
    const tracks = [
      track("a", { instrumentTag: "Bass " }),
      track("b", { instrumentTag: "drums" }),
      track("c", { instrumentTag: "bass" }),
    ];
    const ids = myInstrumentTracks(tracks, { instrumentTag: " bass" });
    expect(ids).toEqual(["a", "c"]);
    expect(myInstrumentTracks(tracks, { instrumentTag: "" })).toEqual([]);
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

  it("finds my tracks by effective instrument, and by tag when both have one (SPEC §30.3)", () => {
    const tracks = [
      track("bass", { name: "Bass DI" }),
      track("lead", { name: "Gtr 1", instrumentTag: "lead" }),
      track("rhythm", { name: "Gtr 2", instrumentTag: "Rhythm" }),
      track("plain", { name: "Kytara" }),
      track("set", { name: "Take 3", instrument: "guitar" }),
      track("odd", { name: "Guitar", instrument: "keys" }),
    ];
    const me = (instrumentTag: string, instrument: Instrument | null = null) =>
      myInstrumentTracks(tracks, { instrumentTag, instrument });
    expect(me("", "guitar")).toEqual(["lead", "rhythm", "plain", "set"]);
    expect(me("rhythm ", "guitar")).toEqual(["rhythm", "plain", "set"]);
    // Guessed from the tag; the tag must then match the tagged tracks.
    expect(me("Kytara")).toEqual(["plain", "set"]);
    expect(me("bass")).toEqual(["bass"]);
    // The chosen instrument wins over the guess from the tag.
    expect(me("bass", "keys")).toEqual(["odd"]);
    // A tag naming no instrument: exact tag match as before.
    expect(me("lead")).toEqual(["lead"]);
    expect(me("")).toEqual([]);
    // A single unrecognised track is the mix.
    const single = [track("only", { name: "Take" })];
    expect(myInstrumentTracks(single, { instrumentTag: "", instrument: "mix" })).toEqual(["only"]);
    expect(myInstrumentTracks(single, { instrumentTag: "", instrument: "other" })).toEqual([]);
  });

  it("turns the louder A/B version down to the quieter one", () => {
    expect(loudnessOffsetDb(-10, -14)).toBe(-4);
    expect(loudnessOffsetDb(-14, -10)).toBe(0);
    expect(loudnessOffsetDb(null, -10)).toBe(0);
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

  it("does not reload the audio when only the track order changes (SPEC §28.5)", () => {
    const key = loadKeyOf(
      "s",
      playableTracks([track("a"), track("b"), track("c")], {}, "high", url),
    );
    expect(
      loadKeyOf("s", playableTracks([track("c"), track("a"), track("b")], {}, "high", url)),
    ).toBe(key);
    // A different version of a moved track still reloads.
    const other = track("c", { current: version({ id: "c-v2" }) });
    expect(
      loadKeyOf("s", playableTracks([other, track("a"), track("b")], {}, "high", url)),
    ).not.toBe(key);
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

describe("practice (SPEC §30.3)", () => {
  it("derives each track's stretch policy from its instrument", () => {
    expect(stretchPolicyOf(track("Lead vox"), false)).toEqual({
      transpose: true,
      profile: "voice",
      voiceBaseHz: 0,
      formant: true,
      formantShift: 0,
    });
    expect(stretchPolicyOf(track("Kick"), false)).toMatchObject({
      transpose: false,
      profile: "percussive",
    });
    expect(stretchPolicyOf(track("Kick", { transpose: true }), false).transpose).toBe(true);
    expect(
      stretchPolicyOf(track("x", { voiceRange: "high", instrument: "vocals" }), false),
    ).toMatchObject({ voiceBaseHz: 400 });
    expect(stretchPolicyOf(track("Rehearsal 3"), true).profile).toBe("mix");
  });

  it("lets the listener override the band default", () => {
    const vox = track("Lead vox", { formantMode: "follow", formantShift: 2 });
    expect(stretchPolicyOf(vox, false)).toMatchObject({ formant: false, formantShift: 2 });
    const mine = {
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      transpose: false,
      formantMode: "preserve" as const,
      formantShift: -3,
    };
    expect(stretchPolicyOf(vox, false, mine)).toMatchObject({
      transpose: false,
      formant: true,
      formantShift: -3,
    });
    // null = back to the band default.
    expect(
      stretchPolicyOf(vox, false, {
        ...mine,
        transpose: null,
        formantMode: null,
        formantShift: null,
      }),
    ).toMatchObject({ transpose: true, formant: false, formantShift: 2 });
  });

  it("joins cents to the semitones for the engine", () => {
    expect(enginePracticeOf({ rate: 0.8, semitones: -3, cents: 25 }, "economy")).toEqual({
      rate: 0.8,
      semitones: -2.75,
      quality: "economy",
    });
  });

  it("reloads when a track's transpose policy changes", () => {
    const v = version({ id: "v1" });
    const playable = (t: Track) => playableTracks([t], { [t.id]: v }, "high", url);
    const a = loadKeyOf("s", playable(track("gtr")));
    expect(loadKeyOf("s", playable(track("gtr")))).toBe(a);
    expect(loadKeyOf("s", playable(track("gtr", { transpose: false })))).not.toBe(a);
  });
});
