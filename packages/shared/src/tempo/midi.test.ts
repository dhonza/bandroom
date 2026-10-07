import { writeMidi, type MidiData, type MidiEvent } from "midi-file";
import { describe, expect, it } from "vitest";
import { decodeMidiText, decodeUtf8, MAX_MIDI_MARKERS, parseMidiTempo } from "./midi";

type Ev = { tick: number } & Record<string, unknown>;

function track(events: Ev[]): MidiEvent[] {
  let last = 0;
  const out = [...events]
    .sort((a, b) => a.tick - b.tick)
    .map(({ tick, ...e }) => {
      const ev = { ...e, deltaTime: tick - last } as unknown as MidiEvent;
      last = tick;
      return ev;
    });
  out.push({ deltaTime: 0, meta: true, type: "endOfTrack" });
  return out;
}

const tempo = (tick: number, bpm: number): Ev => ({
  tick,
  meta: true,
  type: "setTempo",
  microsecondsPerBeat: Math.round(60_000_000 / bpm),
});
const meter = (tick: number, num: number, den: number): Ev => ({
  tick,
  meta: true,
  type: "timeSignature",
  numerator: num,
  denominator: den,
  metronome: 24,
  thirtyseconds: 8,
});
const marker = (tick: number, text: string, type = "marker"): Ev => ({
  tick,
  meta: true,
  type,
  text,
});

function file(tracks: Ev[][], header: Partial<MidiData["header"]> = {}): Uint8Array {
  return Uint8Array.from(
    writeMidi({
      header: { format: 1, numTracks: tracks.length, ticksPerBeat: 480, ...header },
      tracks: tracks.map(track),
    }),
  );
}

describe("parseMidiTempo (SPEC §7.2)", () => {
  it("rejects garbage, format 2 and SMPTE timebases", () => {
    expect(parseMidiTempo(new Uint8Array([1, 2, 3]))).toEqual({ ok: false, error: "MIDI_INVALID" });
    expect(parseMidiTempo(file([[tempo(0, 120)]], { format: 2 }))).toEqual({
      ok: false,
      error: "MIDI_FORMAT",
    });
    const smpte = file([[tempo(0, 120)]], {
      ticksPerBeat: undefined,
      framesPerSecond: 25,
      ticksPerFrame: 40,
    });
    expect(parseMidiTempo(smpte)).toEqual({ ok: false, error: "MIDI_SMPTE" });
    const zero = file([[tempo(0, 120)]]);
    zero[12] = 0;
    zero[13] = 0; // time division 0
    expect(parseMidiTempo(zero)).toEqual({ ok: false, error: "MIDI_INVALID" });
  });

  it("imports steps and meter changes from any track; duplicates at one tick: last wins", () => {
    const r = parseMidiTempo(
      file([
        [meter(0, 4, 4), tempo(0, 96), tempo(0, 100), marker(0, "Intro")],
        [tempo(480 * 8, 140), meter(480 * 8, 3, 4), marker(480 * 8, "Verse", "cuePoint")],
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ppq).toBe(480);
    expect(r.value.format).toBe(1);
    expect(r.value.tempoEvents).toBe(3);
    expect(r.value.bar1OffsetSec).toBe(0);
    expect(r.value.warnings).toEqual([]);
    expect(r.value.map.segments).toEqual([
      { startBeat: 0, bpm: 100, meter: { num: 4, den: 4 }, barIndex: 0 },
      { startBeat: 8, bpm: 140, meter: { num: 3, den: 4 }, barIndex: 2 },
    ]);
    expect(r.value.markers).toEqual([
      { name: "Intro", beat: 0, kind: "marker" },
      { name: "Verse", beat: 8, kind: "cue" },
    ]);
  });

  it("assumes 120 BPM and 4/4 when missing and clamps absurd tempos", () => {
    const none = parseMidiTempo(file([[marker(480, " A marker with spaces ")]]));
    expect(none.ok && none.value.warnings).toEqual([{ code: "noTempo" }]);
    expect(none.ok && none.value.map.segments).toEqual([
      { startBeat: 0, bpm: 120, meter: { num: 4, den: 4 }, barIndex: 0 },
    ]);
    expect(none.ok && none.value.markers[0]?.name).toBe("A marker with spaces");
    const late = parseMidiTempo(file([[tempo(480 * 4, 90), tempo(480 * 8, 5)]]));
    expect(late.ok && late.value.map.segments.map((s) => s.bpm)).toEqual([120, 90, 10]);
    expect(late.ok && late.value.warnings).toEqual([{ code: "tempoClamped", bpm: 5 }]);
  });

  it("moves meter changes off a bar line to the nearest bar, with a warning", () => {
    const r = parseMidiTempo(
      file([
        [
          tempo(0, 120),
          meter(0, 3, 4), // replaces the default 4/4 at bar 1
          meter(480 * 7, 3, 4), // same meter again: ignored
          meter(480 * 7, 6, 8), // beat 7 in 3/4 is bar 3 beat 2 → moved to beat 6 (bar 3)
          meter(480 * 12, 1, 64), // unsupported denominator: ignored
          meter(480 * 12, 0, 4), // invalid: ignored
        ],
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.warnings).toEqual([{ code: "meterRounded", bar: 3 }]);
    expect(r.value.map.segments).toEqual([
      { startBeat: 0, bpm: 120, meter: { num: 3, den: 4 }, barIndex: 0 },
      { startBeat: 6, bpm: 120, meter: { num: 6, den: 8 }, barIndex: 2 },
    ]);
  });

  it("replaces the meter when a change rounds back onto its region start", () => {
    const r = parseMidiTempo(file([[tempo(0, 120), meter(0, 4, 4), meter(480, 3, 4)]]));
    expect(r.ok && r.value.map.segments).toEqual([
      { startBeat: 0, bpm: 120, meter: { num: 3, den: 4 }, barIndex: 0 },
    ]);
    expect(r.ok && r.value.warnings).toEqual([{ code: "meterRounded", bar: 1 }]);
  });

  it("merges tempo events equal to the one before and dedupes markers", () => {
    const r = parseMidiTempo(
      file([[tempo(0, 120), tempo(480 * 4, 120), marker(0, "A"), marker(0, "A"), marker(0, "B")]]),
    );
    expect(r.ok && r.value.map.segments).toHaveLength(1);
    expect(r.ok && r.value.markers.map((x) => x.name)).toEqual(["A", "B"]);
  });

  it("decodes UTF-8 names (Logic) and keeps Latin-1 ones", () => {
    const utf8 = String.fromCharCode(...[0x52, 0x65, 0x66, 0x72, 0xc3, 0xa9, 0x6e]); // Refrén
    const latin1 = "Refrén";
    const r = parseMidiTempo(file([[tempo(0, 120), marker(0, utf8), marker(480, latin1)]]));
    expect(r.ok && r.value.markers.map((x) => x.name)).toEqual(["Refrén", "Refrén"]);
  });

  it("drops markers beyond the import limit", () => {
    const many = Array.from({ length: MAX_MIDI_MARKERS + 3 }, (_, i) => marker(i * 10, `M${i}`));
    const r = parseMidiTempo(file([[tempo(0, 120), ...many]]));
    expect(r.ok && r.value.markers).toHaveLength(MAX_MIDI_MARKERS);
    expect(r.ok && r.value.warnings).toEqual([
      { code: "tooManyMarkers", count: MAX_MIDI_MARKERS + 3 },
    ]);
  });
});

describe("decodeUtf8", () => {
  const b = (...x: number[]) => x;
  it("decodes 1–4 byte sequences", () => {
    expect(decodeUtf8(b(0x41, 0xc5, 0xa1, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x8e, 0xb5))).toBe("Aš€🎵");
    expect(decodeMidiText("abc")).toBe("abc");
  });
  it("rejects invalid, truncated, overlong and surrogate sequences", () => {
    for (const bad of [
      b(0x80),
      b(0xc0, 0x80),
      b(0xf5, 0x80, 0x80, 0x80),
      b(0xc5),
      b(0xc5, 0x41),
      b(0xe0, 0x80, 0x80),
      b(0xed, 0xa0, 0x80),
      b(0xf4, 0x90, 0x80, 0x80),
    ]) {
      expect(decodeUtf8(bad)).toBeNull();
    }
  });
});
