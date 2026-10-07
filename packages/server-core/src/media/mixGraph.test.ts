import fs from "node:fs/promises";
import type { Readable } from "node:stream";
import { generateFixtures, matrix, TONE_FILE } from "@bandroom/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir } from "../testing/tempDir";
import { measureLoudness } from "./analysis";
import { mixChannels, mixdownFilter, mixGain, panLaw, renderMix, type MixInput } from "./mixGraph";
import { probeAudio } from "./probe";
import { DEFAULT_TOOLS, ffmpegArgs, runTool } from "./tools";

let tmp: ReturnType<typeof makeTempDir>;
let run = 0;

beforeAll(async () => {
  await generateFixtures();
  tmp = makeTempDir();
}, 60_000);
afterAll(() => {
  tmp.cleanup();
});

/** A fresh temp dir per render (renderMix writes fixed file names). */
async function render(inputs: MixInput[], codec?: "pcm_f32le" | "pcm_s24le") {
  const dir = `${tmp.dir}/r${run++}`;
  await fs.mkdir(dir, { recursive: true });
  return renderMix({ tools: DEFAULT_TOOLS, tmpDir: dir, ...(codec && { codec }) }, inputs);
}

/** Interleaved stereo float samples of a file. */
async function decodeStereo(file: string): Promise<Float32Array> {
  const chunks: Buffer[] = [];
  await runTool(DEFAULT_TOOLS.ffmpeg, ffmpegArgs("-i", file, "-ac", "2", "-f", "f32le", "-"), {
    stdout: async (s: Readable) => {
      for await (const c of s) chunks.push(c as Buffer);
    },
  });
  const buf = Buffer.concat(chunks);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

const fixture = (name: string) => {
  const f = matrix().find((x) => x.name === name);
  if (!f) throw new Error(`fixture ${name}`);
  return f.file;
};

const input = (over: Partial<MixInput> & { path: string }): MixInput => ({
  gain: 1,
  pan: 0,
  channels: 2,
  law: "stereo",
  offsetSamples: 0,
  ...over,
});

describe("mixdownFilter", () => {
  it("pans mono with equal power, keeps stereo balance, delays by offset, sums unnormalized", () => {
    const f = mixdownFilter(
      [
        { path: "a", gain: 1, pan: 0, channels: 1, law: "mono", offsetSamples: 0 },
        { path: "b", gain: 0.5, pan: 0, channels: 2, law: "stereo", offsetSamples: 4800 },
      ],
      "aresample=48000",
    );
    expect(f).toBe(
      "[0:a]aresample=48000,pan=stereo|c0=0.707107*c0|c1=0.707107*c0[a0];" +
        "[1:a]aresample=48000,pan=stereo|c0=0.500000*c0|c1=0.500000*c1,adelay=delays=4800S:all=1[a1];" +
        "[a0][a1]amix=inputs=2:normalize=0:duration=longest[m]",
    );
  });

  it("feeds both sides of a dual-mono source from its one channel, at unity", () => {
    const f = mixdownFilter(
      [{ path: "a", gain: 1, pan: 0, channels: 1, law: "stereo", offsetSamples: 0 }],
      "aresample=48000",
    );
    expect(f).toBe(
      "[0:a]aresample=48000,pan=stereo|c0=1.000000*c0|c1=1.000000*c0[a0];[a0]anull[m]",
    );
    // Panned hard left: the right side is silent, the left stays at unity.
    expect(
      mixdownFilter(
        [{ path: "a", gain: 1, pan: -1, channels: 1, law: "stereo", offsetSamples: 0 }],
        "x",
      ),
    ).toContain("pan=stereo|c0=1.000000*c0|c1=0.000000*c0");
  });

  it("chooses the pan law from the probe", () => {
    expect(panLaw({ channels: 1 })).toBe("mono");
    expect(panLaw({ channels: 2, dualMono: true })).toBe("stereo");
    expect(panLaw({ channels: 2 })).toBe("stereo");
    expect(panLaw(null)).toBe("stereo");
    // A dual-mono upload's FLAC and Opus hold one channel, its kept original two.
    expect(mixChannels({ channels: 2, dualMono: true }, "flac")).toBe(1);
    expect(mixChannels({ channels: 2, dualMono: true }, "opus")).toBe(1);
    expect(mixChannels({ channels: 2, dualMono: true }, "original")).toBe(2);
    expect(mixChannels({ channels: 1 }, "original")).toBe(1);
    expect(mixChannels({ channels: 2 }, "flac")).toBe(2);
    expect(mixChannels(null, "flac")).toBe(2);
  });
});

describe("mixGain (SPEC §25.6)", () => {
  it("multiplies the version gain with the fader gain", () => {
    expect(mixGain(0, 0)).toBe(1);
    expect(mixGain(-6, 6)).toBeCloseTo(1, 12);
    expect(mixGain(-6, 0)).toBeCloseTo(0.501187, 6);
    expect(mixGain(0, 12)).toBeCloseTo(3.981072, 6);
    expect(mixGain(-120, 40)).toBe(0); // a silenced fader stays silent
  });
});

describe("renderMix (SPEC §5.5)", () => {
  it("refuses an empty mix", async () => {
    await expect(render([])).rejects.toThrow(/at least one input/);
  });

  it(
    "sums the inputs with their offsets into one stereo 48 kHz file",
    { timeout: 120_000 },
    async () => {
      // Tone: 10 s stereo; impulse file: 6 s mono, impulse at 0.5 s, placed at 11 s.
      const r = await render([
        input({ path: TONE_FILE(), gain: 0.25 }),
        input({
          path: fixture("imp_48000_s16_mono"),
          channels: 1,
          law: "mono",
          offsetSamples: 11 * 48_000,
        }),
      ]);
      expect(r.limited).toBe(false);
      const pcm = await decodeStereo(r.path);
      expect(pcm.length / 2).toBe(17 * 48_000);
      let best = 0;
      let at = 0;
      for (let i = 11 * 48_000; i < 12 * 48_000; i++) {
        const a = Math.abs(pcm[2 * i] ?? 0);
        if (a > best) {
          best = a;
          at = i;
        }
      }
      expect(Math.abs(at - 11.5 * 48_000)).toBeLessThanOrEqual(1);
    },
  );

  it("follows the gain in dB", { timeout: 120_000 }, async () => {
    const unity = await render([input({ path: TONE_FILE(), gain: mixGain(-12, 0) })]);
    const quieter = await render([input({ path: TONE_FILE(), gain: mixGain(-12, -12) })]);
    const a = await measureLoudness(unity.path);
    const b = await measureLoudness(quieter.path);
    expect((b.integratedLufs ?? 0) - (a.integratedLufs ?? 0)).toBeCloseTo(-12, 0);
  });

  it(
    "plays a dual-mono source in both channels at unity, true mono at −3 dB per side",
    { timeout: 120_000 },
    async () => {
      // The stored form of both is one channel; only the law differs. −12 dB keeps the limiter off.
      const energy = async (law: "mono" | "stereo") => {
        const r = await render([
          input({
            path: fixture("imp_48000_s16_mono"),
            channels: 1,
            law,
            gain: mixGain(-12, 0),
          }),
        ]);
        const pcm = await decodeStereo(r.path);
        let l = 0;
        let rr = 0;
        for (let i = 0; i + 1 < pcm.length; i += 2) {
          l += (pcm[i] ?? 0) ** 2;
          rr += (pcm[i + 1] ?? 0) ** 2;
        }
        return { l, r: rr };
      };
      const dual = await energy("stereo");
      expect(dual.r).toBeGreaterThan(0);
      expect(dual.l / dual.r).toBeCloseTo(1, 3);
      const mono = await energy("mono");
      expect(mono.l / mono.r).toBeCloseTo(1, 3);
      expect(10 * Math.log10(mono.l / dual.l)).toBeCloseTo(-3, 0);
    },
  );

  it("limits a clipping sum to −1 dBTP", { timeout: 120_000 }, async () => {
    // Two full tones at +6 dB clearly exceed −1 dBTP.
    const r = await render([
      input({ path: TONE_FILE(), gain: mixGain(6, 0) }),
      input({ path: TONE_FILE(), gain: mixGain(6, 0) }),
    ]);
    expect(r.limited).toBe(true);
    expect(r.loudness.truePeakDbtp ?? 0).toBeLessThanOrEqual(-0.9);
  });

  it("keeps the timing and length when the limiter runs", { timeout: 120_000 }, async () => {
    // A 0.9 impulse is above −1 dBTP; at 1 s it must stay exactly at 1.5 s.
    const r = await render([
      input({
        path: fixture("imp_48000_s16_mono"),
        channels: 1,
        law: "stereo",
        offsetSamples: 48_000,
      }),
    ]);
    expect(r.limited).toBe(true);
    const pcm = await decodeStereo(r.path);
    expect(pcm.length / 2).toBe(7 * 48_000);
    let best = 0;
    let at = 0;
    for (let i = 0; i < pcm.length / 2; i++) {
      const a = Math.abs(pcm[2 * i] ?? 0);
      if (a > best) {
        best = a;
        at = i;
      }
    }
    expect([1.5 * 48_000, 4 * 48_000, 6.5 * 48_000]).toContain(at);
    expect(Math.abs(pcm[2 * 1.5 * 48_000] ?? 0)).toBeGreaterThan(0.8);
  });

  it(
    "writes 24-bit PCM when asked, with or without the limiter",
    { timeout: 120_000 },
    async () => {
      const codecOf = async (file: string) => (await probeAudio(file)).bitDepth;
      const quiet = await render(
        [input({ path: TONE_FILE(), gain: mixGain(-12, 0) })],
        "pcm_s24le",
      );
      expect(quiet.limited).toBe(false);
      expect(await codecOf(quiet.path)).toBe(24);
      const loud = await render(
        [input({ path: TONE_FILE(), gain: mixGain(6, 0) }), input({ path: TONE_FILE(), gain: 2 })],
        "pcm_s24le",
      );
      expect(loud.limited).toBe(true);
      expect(await codecOf(loud.path)).toBe(24);
    },
  );
});
