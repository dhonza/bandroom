import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeAtomically } from "./atomic";
import { writeMidiFixtures } from "./midi";
import { writeWav, type SampleFormat } from "./wavWriter";

const exec = promisify(execFile);

export const FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "out");
export const RATES = [44_100, 48_000, 96_000] as const;
export const FORMATS: SampleFormat[] = ["s16", "s24", "f32"];
export const LAYOUTS = ["mono", "stereo", "dualmono"] as const;
export type Layout = (typeof LAYOUTS)[number];

export const IMPULSE_AMPLITUDE = 0.9;
export const SHORT_SECONDS = 6;
export const LONG_SECONDS = 61;

export interface ImpulseFixture {
  name: string;
  file: string;
  sampleRate: number;
  format: SampleFormat;
  layout: Layout;
  channels: number;
  frames: number;
  /** Impulse positions in seconds. */
  impulsesSec: number[];
}

export function impulseFrames(f: Pick<ImpulseFixture, "impulsesSec" | "sampleRate">): number[] {
  return f.impulsesSec.map((s) => Math.round(s * f.sampleRate));
}

function impulseSpec(f: ImpulseFixture) {
  const at = new Set(impulseFrames(f));
  return (frame: number, channel: number) => {
    if (!at.has(frame)) return 0;
    // "stereo": R differs from L so it is not detected as dual-mono.
    return f.layout === "stereo" && channel === 1 ? IMPULSE_AMPLITUDE / 2 : IMPULSE_AMPLITUDE;
  };
}

export function matrix(): ImpulseFixture[] {
  const out: ImpulseFixture[] = [];
  for (const sampleRate of RATES) {
    for (const format of FORMATS) {
      for (const layout of LAYOUTS) {
        const name = `imp_${sampleRate}_${format}_${layout}`;
        out.push({
          name,
          file: path.join(FIXTURES_DIR, `${name}.wav`),
          sampleRate,
          format,
          layout,
          channels: layout === "mono" ? 1 : 2,
          frames: SHORT_SECONDS * sampleRate,
          impulsesSec: [0.5, 3, SHORT_SECONDS - 0.5],
        });
      }
    }
  }
  return out;
}

/** 61 s files with an impulse at 60 s, to catch drift over long offsets (SPEC §6.5). */
export function longFixtures(): ImpulseFixture[] {
  return (
    [
      [44_100, "s24"],
      [96_000, "s24"],
    ] as const
  ).map(([sampleRate, format]) => {
    const name = `long_${sampleRate}_${format}_stereo`;
    return {
      name,
      file: path.join(FIXTURES_DIR, `${name}.wav`),
      sampleRate,
      format,
      layout: "stereo" as const,
      channels: 2,
      frames: LONG_SECONDS * sampleRate,
      impulsesSec: [0.5, 60, LONG_SECONDS - 0.5],
    };
  });
}

export const BWF_FILE = () => path.join(FIXTURES_DIR, "bwf_48000_s24_chunks.wav");
export const MP3_FILE = () => path.join(FIXTURES_DIR, "lossy_44100.mp3");
export const FLAC_FILE = () => path.join(FIXTURES_DIR, "lossless_48000_s16.flac");
export const AIFF_FILE = () => path.join(FIXTURES_DIR, "lossless_44100_s24.aiff");
/** 32-bit float stereo with overs above 0 dBFS and BWF chunks (WavPack storage, v0.7.2). */
export const FLOAT_FILE = () => path.join(FIXTURES_DIR, "float_48000_f32_overs.wav");
export const TONE_FILE = () => path.join(FIXTURES_DIR, "tone_48000_s16_stereo.wav");
export const REAPER_MIDI_FILE = () => path.join(FIXTURES_DIR, "reaper_tempo_map.mid");
export const LOGIC_MIDI_FILE = () => path.join(FIXTURES_DIR, "logic_tempo_map.mid");
export const SMPTE_MIDI_FILE = () => path.join(FIXTURES_DIR, "smpte.mid");

function bextChunk(): Buffer {
  const b = Buffer.alloc(602);
  b.write("BandRoom fixture", 0, "latin1"); // Description
  b.write("BandRoom", 256, "latin1"); // Originator
  b.write("2026-09-28", 320, "latin1");
  b.write("12:00:00", 330, "latin1");
  b.writeUInt32LE(48_000 * 3600, 338); // TimeReference low
  b.writeUInt16LE(1, 346); // version
  return b;
}

function listChunk(): Buffer {
  const text = Buffer.from("Test Song\0", "latin1");
  const inam = Buffer.concat([Buffer.from("INAM", "latin1"), Buffer.alloc(4), text]);
  inam.writeUInt32LE(text.length, 4);
  return Buffer.concat([Buffer.from("INFO", "latin1"), inam]);
}

async function ffmpeg(...args: string[]): Promise<void> {
  await exec(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    ...args,
  ]);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generates all fixtures (skips files that already exist). Deterministic output. Every file is
 * written atomically, so concurrent calls (parallel test files, e2e workers) are safe. `dir`
 * (default {@link FIXTURES_DIR}) is for tests of the generator itself.
 */
export async function generateFixtures(
  opts: { force?: boolean; log?: (m: string) => void; dir?: string } = {},
): Promise<void> {
  const dir = opts.dir ?? FIXTURES_DIR;
  await fs.mkdir(dir, { recursive: true });
  const log = opts.log ?? (() => undefined);
  const at = (file: string) => path.join(dir, path.basename(file));
  /** Writes `file` (in `dir`) via `write(tmp)` unless it exists. */
  const make = async (file: string, write: (tmp: string) => Promise<void>) => {
    const target = at(file);
    if (opts.force !== true && (await exists(target))) return false;
    await writeAtomically(target, write);
    return true;
  };

  for (const f of [...matrix(), ...longFixtures()]) {
    const wrote = await make(f.file, (tmp) =>
      writeWav(tmp, {
        sampleRate: f.sampleRate,
        channels: f.channels,
        format: f.format,
        frames: f.frames,
        sample: impulseSpec(f),
        extensible: f.format === "s24",
      }),
    );
    if (wrote) log(`wrote ${path.basename(f.file)}`);
  }

  const bwf = await make(BWF_FILE(), (tmp) => {
    const sr = 48_000;
    return writeWav(tmp, {
      sampleRate: sr,
      channels: 2,
      format: "s24",
      frames: 4 * sr + 1, // odd frame count → exercises pad bytes elsewhere
      sample: (fr, ch) => 0.25 * Math.sin((2 * Math.PI * (ch ? 660 : 440) * fr) / sr),
      extraChunks: [
        { id: "bext", data: bextChunk() },
        {
          id: "iXML",
          data: Buffer.from(
            '<?xml version="1.0"?><BWFXML><PROJECT>BandRoom</PROJECT></BWFXML>',
            "utf8",
          ),
        },
        { id: "LIST", data: listChunk(), after: true },
        { id: "junk", data: Buffer.from([1, 2, 3]), after: true }, // odd size → pad byte
      ],
    });
  });
  if (bwf) log("wrote BWF fixture");

  await make(FLOAT_FILE(), (tmp) => {
    const sr = 48_000;
    return writeWav(tmp, {
      sampleRate: sr,
      channels: 2,
      format: "f32",
      frames: 3 * sr + 1,
      // Left peaks at +3.5 dBFS (1.5), right stays quiet: float must keep both exactly.
      sample: (fr, ch) => (ch ? 0.01 : 1.5) * Math.sin((2 * Math.PI * (ch ? 660 : 440) * fr) / sr),
      extraChunks: [
        { id: "bext", data: bextChunk() },
        { id: "LIST", data: listChunk(), after: true },
      ],
    });
  });
  await make(TONE_FILE(), (tmp) => {
    const sr = 48_000;
    return writeWav(tmp, {
      sampleRate: sr,
      channels: 2,
      format: "s16",
      frames: 10 * sr,
      sample: (fr, ch) => 0.5 * Math.sin((2 * Math.PI * (ch ? 554.37 : 440) * fr) / sr),
    });
  });
  const tone = at(TONE_FILE());
  await make(MP3_FILE(), (tmp) =>
    ffmpeg("-i", tone, "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k", tmp),
  );
  await make(FLAC_FILE(), (tmp) => ffmpeg("-i", tone, "-c:a", "flac", tmp));
  await make(AIFF_FILE(), (tmp) => ffmpeg("-i", tone, "-ar", "44100", "-c:a", "pcm_s24be", tmp));
  await writeMidiFixtures(dir); // tiny and deterministic: always rewritten (atomically)
  log(`fixtures ready in ${dir}`);
}
