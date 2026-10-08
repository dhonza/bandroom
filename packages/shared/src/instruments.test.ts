import { describe, expect, it } from "vitest";
import {
  INSTRUMENTS,
  InstrumentSchema,
  VoiceRangeSchema,
  defaultTranspose,
  effectiveInstrument,
  effectiveTranspose,
  guessInstrument,
  profileFor,
  transposeKeyName,
  voiceBaseHz,
} from "./instruments";

describe("guessInstrument (SPEC §30.3)", () => {
  it("recognises instruments in English and Czech names and tags", () => {
    expect(guessInstrument("Drums")).toBe("drums");
    expect(guessInstrument("Kick In")).toBe("drums");
    expect(guessInstrument("Bicí")).toBe("drums");
    expect(guessInstrument("Tom 2")).toBe("drums");
    expect(guessInstrument("Perc")).toBe("percussion");
    expect(guessInstrument("Bass DI")).toBe("bass");
    expect(guessInstrument("Baskytara")).toBe("bass");
    expect(guessInstrument("Gtr L")).toBe("guitar");
    expect(guessInstrument("Klávesy")).toBe("keys");
    expect(guessInstrument("Synth pad")).toBe("synth");
    expect(guessInstrument("BV")).toBe("vocals");
    expect(guessInstrument("Zpěv")).toBe("vocals");
    expect(guessInstrument("Housle")).toBe("strings");
    expect(guessInstrument("Sax solo")).toBe("winds");
    expect(guessInstrument("Flute")).toBe("winds");
    expect(guessInstrument("Rehearsal mix")).toBe("mix");
    expect(guessInstrument("Zkouška 3.5.")).toBe("mix");
    expect(guessInstrument("Master")).toBe("mix");
    expect(guessInstrument("Track 3", "bass")).toBe("bass");
  });

  it("prefers the instrument over a generic word and ignores unknown names", () => {
    expect(guessInstrument("Bass Drum")).toBe("drums");
    expect(guessInstrument("Drum mix")).toBe("drums");
    expect(guessInstrument("Take 1")).toBeNull();
    expect(guessInstrument("Tomáš")).toBeNull();
    expect(guessInstrument("")).toBeNull();
    expect(guessInstrument(undefined, null)).toBeNull();
    expect(guessInstrument()).toBeNull();
  });
});

describe("effective instrument and transpose", () => {
  it("uses the stored value, then the guess, then mix for a single track, else other", () => {
    expect(effectiveInstrument({ name: "Bass", instrument: "guitar" })).toBe("guitar");
    expect(effectiveInstrument({ name: "Take", instrumentTag: "voc", instrument: null })).toBe(
      "vocals",
    );
    expect(effectiveInstrument({ name: "Take" })).toBe("other");
    expect(effectiveInstrument({ name: "Take" }, { singleTrack: true })).toBe("mix");
    expect(effectiveInstrument({ name: "Bass" }, { singleTrack: true })).toBe("bass");
  });

  it("does not transpose drums and percussion unless overridden", () => {
    expect(INSTRUMENTS.filter((i) => !defaultTranspose(i))).toEqual(["drums", "percussion"]);
    expect(effectiveTranspose({ name: "Kick" })).toBe(false);
    expect(effectiveTranspose({ name: "Kick", transpose: true })).toBe(true);
    expect(effectiveTranspose({ name: "Bass", transpose: false })).toBe(false);
    expect(effectiveTranspose({ name: "Take", transpose: null }, { singleTrack: true })).toBe(true);
  });

  it("maps instruments to stretch profiles and voice ranges to formant bases", () => {
    expect(INSTRUMENTS.map((i) => [i, profileFor(i)])).toEqual([
      ["drums", "percussive"],
      ["percussion", "percussive"],
      ["bass", "tonal"],
      ["guitar", "tonal"],
      ["keys", "tonal"],
      ["vocals", "voice"],
      ["strings", "tonal"],
      ["winds", "tonal"],
      ["synth", "tonal"],
      ["mix", "mix"],
      ["other", "tonal"],
    ]);
    expect(voiceBaseHz("low")).toBe(100);
    expect(voiceBaseHz("high")).toBe(400);
    expect(voiceBaseHz("auto")).toBe(0);
    expect(voiceBaseHz(null)).toBe(0);
  });

  it("validates the enums", () => {
    expect(InstrumentSchema.safeParse("keys").success).toBe(true);
    expect(InstrumentSchema.safeParse("piano").success).toBe(false);
    expect(VoiceRangeSchema.safeParse("high").success).toBe(true);
    expect(VoiceRangeSchema.safeParse("mid").success).toBe(false);
  });
});

describe("transposeKeyName (SPEC §30.7)", () => {
  it("shifts the note and keeps the suffix", () => {
    expect(transposeKeyName("Am", -2)).toBe("Gm");
    expect(transposeKeyName("C", 2)).toBe("D");
    expect(transposeKeyName("C", 1)).toBe("C#");
    expect(transposeKeyName("C", -1)).toBe("B");
    expect(transposeKeyName("D", -1)).toBe("Db");
    expect(transposeKeyName("e minor", 1)).toBe("F minor");
    expect(transposeKeyName("G dur", 0)).toBe("G dur");
    expect(transposeKeyName("Cmaj", 24)).toBe("Cmaj");
    expect(transposeKeyName("B", 1)).toBe("C");
    expect(transposeKeyName(" Am ", 3)).toBe("Cm");
  });

  it("keeps the accidental style of the original", () => {
    expect(transposeKeyName("Bb", 2)).toBe("C");
    expect(transposeKeyName("Bb", 1)).toBe("B");
    expect(transposeKeyName("Eb", 1)).toBe("E");
    expect(transposeKeyName("Ebm", 3)).toBe("Gbm");
    expect(transposeKeyName("F#m", 1)).toBe("Gm");
    expect(transposeKeyName("F#", 3)).toBe("A");
    expect(transposeKeyName("C#", -1)).toBe("C");
    expect(transposeKeyName("C#", 1)).toBe("D");
    expect(transposeKeyName("C#", 3)).toBe("E");
    expect(transposeKeyName("G#", -1)).toBe("G");
    expect(transposeKeyName("A♭", 1)).toBe("A");
    expect(transposeKeyName("A♭", 2)).toBe("B♭");
    expect(transposeKeyName("F♯ moll", 1)).toBe("G moll");
    expect(transposeKeyName("C♯", 2)).toBe("D♯");
  });

  it("returns null for text that is not a key name", () => {
    expect(transposeKeyName("", 2)).toBeNull();
    expect(transposeKeyName("H moll", 2)).toBeNull();
    expect(transposeKeyName("?", 1)).toBeNull();
  });
});
