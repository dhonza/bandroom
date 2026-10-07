import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "./atomic";
import { writeMidi, type MidiData, type MidiEvent } from "midi-file";

/**
 * MIDI tempo-map fixtures (SPEC §20: constant, steps, meter changes, markers) that mimic what
 * Reaper ("File → Export project MIDI", tempo map + markers) and Logic ("Export → Selection as
 * MIDI File" with the tempo track) write. Built in memory for unit tests and written to
 * `out/` for e2e uploads.
 */

type Ev = { tick: number } & (
  | { type: "setTempo"; bpm: number }
  | { type: "timeSignature"; num: number; den: number; metronome?: number }
  | { type: "marker" | "cuePoint" | "trackName" | "text"; text: string }
  | { type: "keySignature"; key: number; scale: number }
  | { type: "smpteOffset"; hour: number }
  | { type: "noteOn" | "noteOff"; note: number }
);

/** midi-file writes one byte per char: encode names as UTF-8 bytes first. */
const utf8 = (s: string) => String.fromCharCode(...new TextEncoder().encode(s));

function toMidiEvent(e: Ev, deltaTime: number): MidiEvent {
  switch (e.type) {
    case "setTempo":
      return {
        deltaTime,
        meta: true,
        type: "setTempo",
        microsecondsPerBeat: Math.round(60_000_000 / e.bpm),
      };
    case "timeSignature":
      return {
        deltaTime,
        meta: true,
        type: "timeSignature",
        numerator: e.num,
        denominator: e.den,
        metronome: e.metronome ?? 24,
        thirtyseconds: 8,
      };
    case "keySignature":
      return { deltaTime, meta: true, type: "keySignature", key: e.key, scale: e.scale };
    case "smpteOffset":
      return {
        deltaTime,
        meta: true,
        type: "smpteOffset",
        frameRate: 25,
        hour: e.hour,
        min: 0,
        sec: 0,
        frame: 0,
        subFrame: 0,
      };
    case "noteOn":
    case "noteOff":
      return {
        deltaTime,
        channel: 0,
        type: e.type,
        noteNumber: e.note,
        velocity: e.type === "noteOn" ? 100 : 0,
      };
    default:
      return { deltaTime, meta: true, type: e.type, text: utf8(e.text) };
  }
}

/** Absolute-tick events → one MIDI track (stable order within a tick) with end of track. */
function track(events: Ev[], endTick: number): MidiEvent[] {
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.tick - b.e.tick || a.i - b.i);
  let last = 0;
  const out = sorted.map(({ e }) => {
    const ev = toMidiEvent(e, e.tick - last);
    last = e.tick;
    return ev;
  });
  out.push({ deltaTime: Math.max(0, endTick - last), meta: true, type: "endOfTrack" });
  return out;
}

function bytes(data: MidiData): Uint8Array {
  return Uint8Array.from(writeMidi(data));
}

/** A few notes so the file looks like a real export (the importer ignores them). */
function notes(ppq: number, bars: number): Ev[] {
  const out: Ev[] = [];
  for (let b = 0; b < bars; b++) {
    out.push({ tick: b * 4 * ppq, type: "noteOn", note: 36 });
    out.push({ tick: b * 4 * ppq + ppq / 2, type: "noteOff", note: 36 });
  }
  return out;
}

export interface ExpectedSegment {
  startBeat: number;
  bpm: number;
  num: number;
  den: number;
}

export interface MidiFixture {
  name: string;
  bytes: Uint8Array;
  /** Expected tempo segments after import. */
  segments: ExpectedSegment[];
  /** Expected markers (name, quarter-note beat). */
  markers: { name: string; beat: number; kind: "marker" | "cue" }[];
}

/**
 * Reaper: PPQ 960, tempo map and markers in the first track (named after the project), steps
 * 120 → 140 at bar 9, 3/4 at bar 13, 6/8 at 90 BPM at bar 17 and a linear ramp 90 → 120 over
 * bars 19–20 exported as a tempo event every sixteenth.
 */
export function reaperFixture(): MidiFixture {
  const ppq = 960;
  const q = (beat: number) => Math.round(beat * ppq);
  const ev: Ev[] = [
    { tick: 0, type: "trackName", text: "Loop me (tempo map)" },
    { tick: 0, type: "timeSignature", num: 4, den: 4 },
    { tick: 0, type: "setTempo", bpm: 120 },
    { tick: 0, type: "marker", text: "Intro" },
    { tick: q(16), type: "marker", text: "Verse 1" },
    { tick: q(32), type: "setTempo", bpm: 140 },
    { tick: q(32), type: "marker", text: "Chorus" },
    { tick: q(48), type: "timeSignature", num: 3, den: 4 },
    { tick: q(48), type: "marker", text: "Bridge" },
    { tick: q(60), type: "timeSignature", num: 6, den: 8 },
    { tick: q(60), type: "setTempo", bpm: 90 },
    { tick: q(60), type: "marker", text: "Outro" },
  ];
  // Ramp over bars 19–20 (6/8: 3 quarters per bar) → beats 66..72, then 120 from bar 21.
  const ramp: ExpectedSegment[] = [];
  for (let i = 1; i < 24; i++) {
    const beat = 66 + i * 0.25;
    const bpm = Math.round((90 + (30 * i) / 24) * 1000) / 1000;
    ev.push({ tick: q(beat), type: "setTempo", bpm });
    ramp.push({ startBeat: beat, bpm, num: 6, den: 8 });
  }
  ev.push({ tick: q(72), type: "setTempo", bpm: 120 });
  const end = q(84);
  return {
    name: "reaper_tempo_map.mid",
    bytes: bytes({
      header: { format: 1, numTracks: 2, ticksPerBeat: ppq },
      tracks: [
        track(ev, end),
        track([{ tick: 0, type: "trackName", text: "Drums" }, ...notes(ppq, 8)], end),
      ],
    }),
    segments: [
      { startBeat: 0, bpm: 120, num: 4, den: 4 },
      { startBeat: 32, bpm: 140, num: 4, den: 4 },
      { startBeat: 48, bpm: 140, num: 3, den: 4 },
      { startBeat: 60, bpm: 90, num: 6, den: 8 },
      ...ramp,
      { startBeat: 72, bpm: 120, num: 6, den: 8 },
    ],
    markers: [
      { name: "Intro", beat: 0, kind: "marker" },
      { name: "Verse 1", beat: 16, kind: "marker" },
      { name: "Chorus", beat: 32, kind: "marker" },
      { name: "Bridge", beat: 48, kind: "marker" },
      { name: "Outro", beat: 60, kind: "marker" },
    ],
  };
}

/**
 * Logic: PPQ 480, a tempo track named after the song with an SMPTE offset of 1:00:00:00, a key
 * signature, the initial meter and tempo written twice at tick 0 (the last wins), UTF-8 marker
 * names, a cue point, 7/8 at bar 9 and a tempo change in the middle of a bar.
 */
export function logicFixture(): MidiFixture {
  const ppq = 480;
  const q = (beat: number) => Math.round(beat * ppq);
  const ev: Ev[] = [
    { tick: 0, type: "trackName", text: "Píseň" },
    { tick: 0, type: "smpteOffset", hour: 1 },
    { tick: 0, type: "timeSignature", num: 4, den: 4 },
    { tick: 0, type: "keySignature", key: 0, scale: 0 },
    { tick: 0, type: "setTempo", bpm: 96 },
    { tick: 0, type: "timeSignature", num: 4, den: 4, metronome: 24 },
    { tick: 0, type: "setTempo", bpm: 100 },
    { tick: q(8), type: "marker", text: "Sloka" },
    { tick: q(24), type: "marker", text: "Refrén" },
    { tick: q(32), type: "timeSignature", num: 7, den: 8 },
    { tick: q(32), type: "cuePoint", text: "Break" },
    // Bar 10 (7/8 = 3.5 quarters per bar) starts at beat 35.5; tempo change on its 3rd eighth.
    { tick: q(35.5 + 1), type: "setTempo", bpm: 128 },
    { tick: q(35.5 + 3.5 * 2), type: "timeSignature", num: 4, den: 4 },
    { tick: q(35.5 + 3.5 * 2), type: "marker", text: "Konec" },
  ];
  const end = q(60);
  return {
    name: "logic_tempo_map.mid",
    bytes: bytes({
      header: { format: 1, numTracks: 2, ticksPerBeat: ppq },
      tracks: [
        track(ev, end),
        track([{ tick: 0, type: "trackName", text: "Inst 1" }, ...notes(ppq, 4)], end),
      ],
    }),
    segments: [
      { startBeat: 0, bpm: 100, num: 4, den: 4 },
      { startBeat: 32, bpm: 100, num: 7, den: 8 },
      { startBeat: 36.5, bpm: 128, num: 7, den: 8 },
      { startBeat: 42.5, bpm: 128, num: 4, den: 4 },
    ],
    markers: [
      { name: "Sloka", beat: 8, kind: "marker" },
      { name: "Refrén", beat: 24, kind: "marker" },
      { name: "Break", beat: 32, kind: "cue" },
      { name: "Konec", beat: 42.5, kind: "marker" },
    ],
  };
}

/** Type 0, constant 120 BPM 4/4, one marker. */
export function constantFixture(): MidiFixture {
  const ppq = 96;
  return {
    name: "constant_120.mid",
    bytes: bytes({
      header: { format: 0, numTracks: 1, ticksPerBeat: ppq },
      tracks: [
        track(
          [
            { tick: 0, type: "setTempo", bpm: 120 },
            { tick: 0, type: "timeSignature", num: 4, den: 4 },
            { tick: 4 * ppq, type: "marker", text: "Bar 2" },
            ...notes(ppq, 2),
          ],
          8 * ppq,
        ),
      ],
    }),
    segments: [{ startBeat: 0, bpm: 120, num: 4, den: 4 }],
    markers: [{ name: "Bar 2", beat: 4, kind: "marker" }],
  };
}

/** SMPTE timebase (25 fps × 40 ticks): must be rejected with a clear error. */
export function smpteFixtureBytes(): Uint8Array {
  return bytes({
    header: { format: 1, numTracks: 1, framesPerSecond: 25, ticksPerFrame: 40 },
    tracks: [track([{ tick: 0, type: "setTempo", bpm: 120 }], 1000)],
  });
}

export const MIDI_FIXTURES = () => [reaperFixture(), logicFixture(), constantFixture()];

export const midiFixtureFile = (name: string, dir: string) => path.join(dir, name);

/** Writes the MIDI fixtures (and the SMPTE one) into `dir`, each atomically. */
export async function writeMidiFixtures(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const files = [
    ...MIDI_FIXTURES().map((f) => ({ name: f.name, bytes: f.bytes })),
    { name: "smpte.mid", bytes: smpteFixtureBytes() },
  ];
  for (const f of files) {
    await writeAtomically(path.join(dir, f.name), (tmp) => fs.writeFile(tmp, f.bytes));
  }
}
