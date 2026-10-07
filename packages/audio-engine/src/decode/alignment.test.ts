import fs from "node:fs/promises";
import {
  generateFixtures,
  impulseFrames,
  longFixtures,
  matrix,
  type ImpulseFixture,
} from "@bandroom/fixtures";
import {
  createTestDb,
  getBlob,
  getVariant,
  insertUser,
  makeTempDir,
  type Db,
} from "@bandroom/server-core";
import {
  addOriginal,
  correlationLag,
  createHarness,
  decodeMono,
  peakNear,
  runOneJob,
  variantPath,
  type Harness,
} from "@bandroom/server-core/testing/ingest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flacSeekPoint, opusSeekPoint, type SeekIndex } from "./seek";
import {
  FlacStream,
  flacSourceStart,
  frames48k,
  OpusStream,
  type PcmBlock,
  type StreamDecoder,
} from "./streams";
import { createFlacCodec, createOpusCodec } from "./wasm";

/**
 * SPEC §6.5 alignment test, engine side: fixtures go through the real ingest pipeline, then the
 * engine's own decoder path (WASM libopus/libFLAC, Ogg demuxer, pre-skip, resampler) must put
 * every impulse where it belongs, from the start of the file and after a Range seek.
 */

let t: ReturnType<typeof createTestDb>;
let db: Db;
let tmp: ReturnType<typeof makeTempDir>;
let h: Harness;
let uploader: string;

beforeAll(async () => {
  await generateFixtures();
  t = createTestDb();
  db = t.db;
  tmp = makeTempDir();
  h = createHarness(db, tmp.dir);
  uploader = insertUser(db, {
    username: "up",
    displayName: "Up",
    passwordHash: "x",
    globalRole: "member",
  }).id;
}, 60_000);
afterAll(() => {
  t.close();
  tmp.cleanup();
});

const meta = (assetId: string, variant: string) =>
  JSON.parse(getVariant(db, assetId, variant)?.meta ?? "null") as Record<string, number>;

async function seekIndex(assetId: string, variant: string): Promise<SeekIndex> {
  const v = getVariant(db, assetId, `seekindex_${variant}`);
  const blob = v && getBlob(db, v.blobHash);
  if (!blob) throw new Error("no seek index");
  return JSON.parse(
    await fs.readFile(await h.storage.localPath(blob.storageKey), "utf8"),
  ) as SeekIndex;
}

/** Runs a decoder over `bytes` in 64 kB pieces (like a streaming fetch) and returns channel 0. */
async function run(
  dec: StreamDecoder,
  bytes: Uint8Array,
): Promise<{ first: number; pcm: Float32Array }> {
  const blocks: PcmBlock[] = [];
  for (let p = 0; p < bytes.length; p += 65_536)
    blocks.push(...(await dec.push(bytes.subarray(p, p + 65_536))));
  blocks.push(...(await dec.flush()));
  dec.free();
  const first = blocks[0]?.frame ?? 0;
  let n = 0;
  for (const b of blocks) {
    expect(b.frame).toBe(first + n); // contiguous
    n += b.data[0]?.length ?? 0;
  }
  const pcm = new Float32Array(n);
  let o = 0;
  for (const b of blocks) {
    pcm.set(b.data[0] ?? [], o);
    o += b.data[0]?.length ?? 0;
  }
  return { first, pcm };
}

async function openVariant(assetId: string, variant: "flac" | "opus" | "opus_low", from: number) {
  const bytes = new Uint8Array(await fs.readFile(await variantPath(h, assetId, variant)));
  const m = meta(assetId, variant);
  const index = await seekIndex(assetId, variant);
  if (variant === "flac") {
    const sr = m.sampleRate ?? 48_000;
    const point = flacSeekPoint(index, flacSourceStart(from, sr));
    const totalFrames = m.durationSamples ?? 0;
    const dec = new FlacStream(
      await createFlacCodec(),
      { sampleRate: sr, channels: m.channels ?? 1, totalFrames },
      point.frame,
      from,
    );
    return { dec, bytes: bytes.subarray(point.byteOffset), total: frames48k(totalFrames, sr) };
  }
  const preSkip = m.preSkip ?? 0;
  const total = m.durationSamples48k ?? 0;
  const point =
    from === 0 ? { byteOffset: 0, startDecoded: 0 } : opusSeekPoint(index, preSkip, from);
  const dec = new OpusStream(
    await createOpusCodec(m.channels ?? 1),
    { channels: m.channels ?? 1, preSkip, totalSamples: total },
    point.startDecoded,
    from,
  );
  return { dec, bytes: bytes.subarray(point.byteOffset), total };
}

describe("engine decoder alignment (SPEC §6.5)", () => {
  const cases: ImpulseFixture[] = [...matrix(), ...longFixtures()];
  for (const f of cases) {
    it(f.name, { timeout: 120_000 }, async () => {
      const asset = await addOriginal(h, f.file, uploader);
      const { status } = await runOneJob(h, "audio.ingest", { assetId: asset.id, role: "track" });
      expect(status).toBe("done");
      const ref48 = await decodeMono(f.file, 48_000);
      const expected48 = frames48k(f.frames, f.sampleRate);
      const impulses48 = f.impulsesSec.map((s) => Math.round(s * 48_000));
      expect(impulseFrames(f).length).toBe(impulses48.length);

      for (const variant of ["flac", "opus", "opus_low"] as const) {
        const full = await openVariant(asset.id, variant, 0);
        const { first, pcm } = await run(full.dec, full.bytes);
        expect(first, variant).toBe(0);
        expect(pcm.length, `${variant} length`).toBe(expected48);
        const tolerance = variant === "opus_low" ? 4 : 1; // decision log, M3
        for (const want of impulses48) {
          if (variant === "flac")
            expect(Math.abs(peakNear(pcm, want) - want)).toBeLessThanOrEqual(1);
          const lag = correlationLag(ref48, pcm, want);
          expect(Math.abs(lag), `${variant} impulse at ${want}`).toBeLessThanOrEqual(tolerance);
        }

        // Range seek to 0.4 s before the middle impulse: same position, same samples.
        const target = (impulses48[1] ?? 0) - 19_200;
        const sought = await openVariant(asset.id, variant, target);
        const s = await run(sought.dec, sought.bytes);
        expect(s.first, `${variant} seek start`).toBe(target);
        expect(s.pcm.length).toBe(expected48 - target);
        let maxDiff = 0;
        for (let i = 0; i < 48_000 && i < s.pcm.length; i++)
          maxDiff = Math.max(maxDiff, Math.abs((s.pcm[i] ?? 0) - (pcm[target + i] ?? 0)));
        expect(maxDiff, `${variant} seek vs full decode`).toBeLessThan(
          variant === "flac" ? 1e-6 : 1e-3,
        );
      }
    });
  }
});
