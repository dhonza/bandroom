import { describe, expect, it } from "vitest";
import { PALETTE_COLORS } from "./content";
import { AUTO_COLOR_ORDER, autoTrackColor, instrumentColor } from "./trackColors";

describe("instrumentColor (SPEC §25.10)", () => {
  it("recognises instruments in English and Czech names", () => {
    expect(instrumentColor("Drums")).toBe("red");
    expect(instrumentColor("Kick In")).toBe("red");
    expect(instrumentColor("Bicí")).toBe("red");
    expect(instrumentColor("Bass DI")).toBe("orange");
    expect(instrumentColor("Baskytara")).toBe("orange");
    expect(instrumentColor("Gtr L")).toBe("yellow");
    expect(instrumentColor("Kytara 2")).toBe("yellow");
    expect(instrumentColor("Keys")).toBe("cyan");
    expect(instrumentColor("Klávesy")).toBe("cyan");
    expect(instrumentColor("Lead Vox")).toBe("violet");
    expect(instrumentColor("BV")).toBe("violet");
    expect(instrumentColor("Zpěv")).toBe("violet");
    expect(instrumentColor("Sax solo")).toBe("gold");
    expect(instrumentColor("Trumpet")).toBe("gold");
    expect(instrumentColor("Cello")).toBe("teal");
    expect(instrumentColor("Flute")).toBe("mint");
  });

  it("also reads the instrument tag and ignores unknown names", () => {
    expect(instrumentColor("Track 3", "bass")).toBe("orange");
    expect(instrumentColor("Take 1")).toBeNull();
    expect(instrumentColor("")).toBeNull();
    // Some words match only whole ("tom", not "Tomáš"), others at a word start only.
    expect(instrumentColor("Tom 2")).toBe("red");
    expect(instrumentColor("Tomáš")).toBeNull();
    expect(instrumentColor("bvx")).toBeNull();
    expect(instrumentColor("abass")).toBeNull();
  });
});

describe("autoTrackColor", () => {
  it("uses the instrument colour even when another track has it", () => {
    expect(autoTrackColor({ name: "Bass" }, { usedColors: ["orange"], trackCount: 1 })).toBe(
      "orange",
    );
  });

  it("uses the stored instrument first; mix and other have no colour", () => {
    const song = { usedColors: ["red"], trackCount: 1 };
    expect(autoTrackColor({ name: "Take", instrument: "vocals" }, song)).toBe("violet");
    expect(autoTrackColor({ name: "Bass", instrument: "keys" }, song)).toBe("cyan");
    expect(autoTrackColor({ name: "Bass", instrument: "other" }, song)).toBe("orange");
    expect(autoTrackColor({ name: "Take", instrument: "mix" }, song)).toBe("orange");
    expect(autoTrackColor({ name: "Rehearsal mix" }, song)).toBe("orange");
    expect(autoTrackColor({ name: "Take", instrument: "winds" }, song)).toBe("gold");
    expect(autoTrackColor({ name: "Flute", instrument: "winds" }, song)).toBe("mint");
    expect(autoTrackColor({ name: "Take", instrumentTag: null, instrument: null }, song)).toBe(
      "orange",
    );
  });

  it("otherwise takes the first unused palette colour", () => {
    expect(autoTrackColor({ name: "Take" }, { usedColors: [], trackCount: 0 })).toBe("red");
    expect(autoTrackColor({ name: "Take" }, { usedColors: ["red", "orange"], trackCount: 2 })).toBe(
      "yellow",
    );
  });

  it("hands out the new colours after the first eight", () => {
    const eight = ["red", "orange", "yellow", "green", "teal", "blue", "violet", "pink"];
    expect(autoTrackColor({ name: "x" }, { usedColors: eight, trackCount: 8 })).toBe("cyan");
  });

  it("goes round-robin once every colour is used", () => {
    expect(new Set(AUTO_COLOR_ORDER)).toEqual(new Set(PALETTE_COLORS));
    const all = [...PALETTE_COLORS];
    expect(autoTrackColor({ name: "x" }, { usedColors: all, trackCount: 16 })).toBe("red");
    expect(autoTrackColor({ name: "x" }, { usedColors: all, trackCount: 18 })).toBe("yellow");
  });
});
