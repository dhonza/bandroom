import fs from "node:fs/promises";
import {
  BWF_FILE,
  FLAC_FILE,
  AIFF_FILE,
  generateFixtures,
  impulseFrames,
  longFixtures,
  matrix,
  MP3_FILE,
  type ImpulseFixture,
} from "@bandroom/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/connection";
import { getJob } from "../jobs/queue";
import { collectGarbageBlobs, getBlob } from "../storage/blobs";
import { createTestDb } from "../testing/testDb";
import { makeTempDir } from "../testing/tempDir";
import {
  addOriginal,
  correlationLag,
  createHarness,
  decodeMono,
  peakNear,
  runOneJob,
  variantPath,
  type Harness,
} from "../testing/ingestHarness";
import { setSetting } from "../settings/registry";
import { assetProbe, getAsset } from "./assets";
import { audioMd5 } from "./analysis";
import { decodeDat } from "./peaks";
import { getUsage, getVariant, listVariants } from "./variants";
import { durationSamples48k } from "./ingest";
import {
  buildWavMeta,
  parseWavMeta,
  rawFormatFor,
  reconstructWav,
  WavMetaTooLargeError,
} from "./wav";
import { DEFAULT_TOOLS, ffmpegArgs, runTool } from "./tools";
import { insertUser } from "../auth/users";
import type { UploadOptions } from "@bandroom/shared";
import { eq } from "drizzle-orm";
import { createProjectRow } from "../content/projects";
import { createSongRow } from "../content/songs";
import { addTrackVersion, createTrackWithVersion, getTrackVersionRow } from "../content/tracks";
import { assets } from "../db/schema";
import { listEvents } from "../events/record";
import { Readable } from "node:stream";

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

async function ingest(file: string) {
  const asset = await addOriginal(h, file, uploader);
  const { status, job } = await runOneJob(h, "audio.ingest", { assetId: asset.id });
  expect(getJob(db, job.id)?.error ?? null).toBeNull();
  expect(status).toBe("done");
  return asset.id;
}

const meta = (assetId: string, variant: string) =>
  JSON.parse(getVariant(db, assetId, variant)?.meta ?? "null") as Record<string, unknown>;

describe("audio.ingest alignment matrix (SPEC §6.5)", () => {
  const cases: ImpulseFixture[] = [...matrix(), ...longFixtures()];
  for (const f of cases) {
    it(f.name, { timeout: 60_000 }, async () => {
      const id = await ingest(f.file);
      const probe = assetProbe(getAsset(db, id) ?? (undefined as never));
      expect(probe?.dualMono).toBe(f.layout === "dualmono");
      expect(getAsset(db, id)?.status).toBe("ready");

      // Variants present; original kept only for float sources.
      const names = listVariants(db, id)
        .map((v) => v.variant)
        .sort();
      const expected = [
        "flac",
        "opus",
        "opus_low",
        "peaks",
        "seekindex_flac",
        "seekindex_opus",
        "seekindex_opus_low",
        "wavmeta",
      ];
      expect(names).toEqual(f.format === "f32" ? [...expected, "original"].sort() : expected);
      expect(meta(id, "flac")).toMatchObject({
        nearLossless: f.format === "f32",
        verified: f.format !== "f32",
      });

      // Mono playback for mono and dual-mono sources.
      const channels = f.layout === "stereo" ? 2 : 1;
      expect(meta(id, "opus")).toMatchObject({ channels, sampleRate: 48_000 });
      expect(meta(id, "flac")).toMatchObject({ channels });

      // FLAC: impulses at the exact source frames.
      const flac = await decodeMono(await variantPath(h, id, "flac"));
      expect(flac.length).toBe(f.frames);
      for (const frame of impulseFrames(f)) expect(peakNear(flac, frame)).toBe(frame);

      // Opus: exact 48 kHz length, and each impulse aligned with the source timing, measured by
      // cross-correlation against the source resampled to 48 kHz (robust to codec smearing).
      // ±1 frame for opus; ±4 frames (< 0.1 ms) for the 48 kbps opus_low, where a single-sample
      // click is smeared by a few samples (decision log, "Alignment tolerance").
      const expected48 = durationSamples48k(f.frames, f.sampleRate);
      const ref48 = await decodeMono(f.file, 48_000);
      for (const v of ["opus", "opus_low"]) {
        expect(meta(id, v)).toMatchObject({
          durationSamples48k: expected48,
          decodedSamples: expected48,
        });
        const pcm = await decodeMono(await variantPath(h, id, v));
        expect(pcm.length).toBe(expected48);
        const tolerance = v === "opus_low" ? 4 : 1;
        for (const s of f.impulsesSec) {
          const want = Math.round(s * 48_000);
          expect(Math.abs(peakNear(ref48, want) - want)).toBeLessThanOrEqual(1);
          const lag = correlationLag(ref48, pcm, want);
          expect(Math.abs(lag), `${v} impulse at ${s}s`).toBeLessThanOrEqual(tolerance);
        }
      }
    });
  }
});

describe("audio.ingest details", () => {
  it(
    "keeps a lossless original only when configured, and verifies the FLAC by MD5",
    { timeout: 60_000 },
    async () => {
      const f = matrix().find((x) => x.name === "imp_48000_s24_stereo");
      if (!f) throw new Error("fixture");
      setSetting(db, "keepOriginalLossless", true);
      const id = await ingest(f.file);
      setSetting(db, "keepOriginalLossless", false);
      expect(getVariant(db, id, "original")).toBeDefined();
      expect(await audioMd5(await variantPath(h, id, "flac"))).toBe(await audioMd5(f.file));
    },
  );

  it(
    "keeps the original until the job succeeds, so a retry after a late failure works",
    { timeout: 60_000 },
    async () => {
      // An ffmpeg wrapper that fails only the loudness pass (after the FLAC is verified).
      const ffmpeg = `${h.root}/ffmpeg-fail-loudness.sh`;
      await fs.writeFile(
        ffmpeg,
        `#!/bin/sh\ncase "$*" in *ebur128*) exit 1;; esac\nexec "${DEFAULT_TOOLS.ffmpeg}" "$@"\n`,
        { mode: 0o755 },
      );
      const asset = await addOriginal(h, BWF_FILE(), uploader);
      const payload = { assetId: asset.id };
      const failed = await runOneJob(h, "audio.ingest", payload, { ...DEFAULT_TOOLS, ffmpeg });
      expect(failed.status).not.toBe("done");
      expect(getVariant(db, asset.id, "original")).toBeDefined();

      const retry = await runOneJob(h, "audio.ingest", payload);
      expect(getJob(db, retry.job.id)?.error ?? null).toBeNull();
      expect(retry.status).toBe("done");
      expect(getVariant(db, asset.id, "original")).toBeUndefined();
    },
  );

  it("handles lossy sources: keeps the original, no FLAC", { timeout: 60_000 }, async () => {
    const id = await ingest(MP3_FILE());
    const names = listVariants(db, id)
      .map((v) => v.variant)
      .sort();
    expect(names).toEqual([
      "opus",
      "opus_low",
      "original",
      "peaks",
      "seekindex_opus",
      "seekindex_opus_low",
    ]);
    // One bitrate profile for every track (SPEC §5.3, M21).
    expect(meta(id, "opus")).toMatchObject({ bitrate: 96, channels: 2 });
    expect(assetProbe(getAsset(db, id) ?? (undefined as never))).toMatchObject({
      lossless: false,
      codec: "mp3",
    });
  });

  it("accepts FLAC and AIFF sources (no wavmeta)", { timeout: 60_000 }, async () => {
    for (const file of [FLAC_FILE(), AIFF_FILE()]) {
      const id = await ingest(file);
      const names = listVariants(db, id).map((v) => v.variant);
      expect(names).toContain("flac");
      expect(names).not.toContain("wavmeta");
      expect(names).not.toContain("original");
    }
  });

  it("ingests a WAV with oversized header chunks without wavmeta (review M6)", async () => {
    // A real data chunk after a 9 MB `junk` chunk: ingest must not keep (or allocate) it.
    const src = await fs.readFile(BWF_FILE());
    const dataAt = src.indexOf("data");
    const junk = Buffer.alloc(8 + 9 * 1024 * 1024);
    junk.write("junk", 0, "latin1");
    junk.writeUInt32LE(9 * 1024 * 1024, 4);
    const out = Buffer.concat([src.subarray(0, dataAt), junk, src.subarray(dataAt)]);
    out.writeUInt32LE(out.length - 8, 4);
    const file = `${tmp.dir}/hostile.wav`;
    await fs.writeFile(file, out);
    await expect(buildWavMeta(file)).rejects.toBeInstanceOf(WavMetaTooLargeError);
    const id = await ingest(file);
    const names = listVariants(db, id).map((v) => v.variant);
    expect(names).toContain("flac");
    expect(names).not.toContain("wavmeta");
  }, 60_000);

  it(
    "measures loudness and writes peaks with a 1024-point overview",
    { timeout: 60_000 },
    async () => {
      const id = await ingest(BWF_FILE());
      const probe = assetProbe(getAsset(db, id) ?? (undefined as never));
      expect(probe?.loudness?.integratedLufs).toBeLessThan(-5);
      expect(probe?.loudness?.integratedLufs).toBeGreaterThan(-30);
      const peaks = decodeDat(await fs.readFile(await variantPath(h, id, "peaks")));
      expect(peaks.spp).toBe(256);
      expect(peaks.sampleRate).toBe(48_000);
      expect(peaks.pairs.length / 2).toBe(Math.ceil((4 * 48_000 + 1) / 256));
      const overview = meta(id, "peaks").overview as number[];
      expect(overview).toHaveLength(1024);
      expect(Math.max(...overview)).toBeGreaterThan(20); // 0.25 amplitude ≈ 32/127
    },
  );

  it(
    "reconstructs the WAV: audio MD5 and non-audio chunks identical and in order (SPEC §5.6)",
    { timeout: 60_000 },
    async () => {
      const id = await ingest(BWF_FILE());
      const wm = parseWavMeta(await fs.readFile(await variantPath(h, id, "wavmeta")));
      expect(wm.index.chunks.map((c) => c.id)).toEqual([
        "fmt ",
        "bext",
        "iXML",
        "data",
        "LIST",
        "junk",
      ]);
      const { format } = rawFormatFor(wm.index.fmt.encoding, wm.index.fmt.bitsPerSample);
      const out = `${tmp.dir}/reconstructed.wav`;
      const fh = await fs.open(out, "w");
      const pcm: Buffer[] = [];
      await runTool(
        DEFAULT_TOOLS.ffmpeg,
        ffmpegArgs("-i", await variantPath(h, id, "flac"), "-f", format, "-"),
        {
          stdout: async (s: Readable) => {
            for await (const c of s) pcm.push(c as Buffer);
          },
        },
      );
      for await (const part of reconstructWav(wm, Readable.from(pcm))) await fh.write(part);
      await fh.close();
      const original = await fs.readFile(BWF_FILE());
      const rebuilt = await fs.readFile(out);
      expect(rebuilt.equals(original)).toBe(true);
    },
  );

  it("marks unsupported files failed without retrying", async () => {
    const bogus = `${tmp.dir}/bogus.wav`;
    await fs.writeFile(bogus, "definitely not audio");
    const asset = await addOriginal(h, bogus, uploader);
    const { status, job } = await runOneJob(h, "audio.ingest", {
      assetId: asset.id,
    });
    expect(status).toBe("failed");
    expect(getJob(db, job.id)?.attempts).toBe(1);
    expect(getAsset(db, asset.id)).toMatchObject({ status: "failed" });
    expect(h.events.some((e) => e.type === "asset.failed")).toBe(true);
  });

  it("accounts usage per uploader and garbage-collects unreferenced blobs after 24 h", async () => {
    const usage = getUsage(db, uploader);
    expect(usage).toBeGreaterThan(0);
    // Originals of verified integer sources were released: they are GC candidates after 24 h.
    const { deleted } = await collectGarbageBlobs(db, h.storage, Date.now() + 25 * 3600_000);
    expect(deleted).toBeGreaterThan(0);
    // Referenced blobs survive.
    const any = matrix()[0];
    expect(any).toBeDefined();
    const v = listVariants(db, await ingest(matrix()[0]?.file ?? "")).find(
      (x) => x.variant === "flac",
    );
    expect(v && getBlob(db, v.blobHash)).toBeDefined();
  }, 60_000);
});

describe("audio.ingest upload options (SPEC §28.2)", () => {
  /** An uploaded file on a track version (two versions share it: a copy), with options. */
  async function versionWith(file: string, options: UploadOptions | null) {
    const asset = await addOriginal(h, file, uploader);
    if (options)
      db.update(assets)
        .set({ ingestOptions: JSON.stringify(options) })
        .where(eq(assets.id, asset.id))
        .run();
    const project = createProjectRow(db, { name: "P", createdBy: uploader });
    const song = createSongRow(db, { projectId: project.id, title: "S", createdBy: uploader });
    const { track, version } = createTrackWithVersion(db, {
      songId: song.id,
      name: "Bass",
      assetId: asset.id,
      uploadedBy: uploader,
    });
    const copy = addTrackVersion(db, {
      trackId: track.id,
      assetId: asset.id,
      uploadedBy: uploader,
    });
    return { asset, song, versions: [version.id, copy.id] };
  }

  it(
    "lossy only: Opus at the preset, no FLAC or original, versions archived on upload",
    {
      timeout: 60_000,
    },
    async () => {
      const { asset, song, versions } = await versionWith(BWF_FILE(), {
        lossyOnly: true,
        quality: "high",
      });
      const before = h.events.length;
      const original = getBlob(db, getVariant(db, asset.id, "original")?.blobHash ?? "");
      const usageBefore = getUsage(db, uploader) - (original?.sizeBytes ?? 0);
      const { status } = await runOneJob(h, "audio.ingest", { assetId: asset.id });
      expect(status).toBe("done");
      expect(getAsset(db, asset.id)?.status).toBe("ready");
      const names = listVariants(db, asset.id)
        .map((v) => v.variant)
        .sort();
      expect(names).toEqual(["opus", "opus_low", "peaks", "seekindex_opus", "seekindex_opus_low"]);
      expect(meta(asset.id, "opus")).toMatchObject({ bitrate: 128, quality: "high" });
      expect(meta(asset.id, "opus_low")).toMatchObject({ bitrate: 48 });
      expect(meta(asset.id, "opus_low").quality).toBeUndefined();
      // Usage: only what is kept.
      const kept = listVariants(db, asset.id).reduce(
        (sum, v) => sum + (getBlob(db, v.blobHash)?.sizeBytes ?? 0),
        0,
      );
      expect(getUsage(db, uploader)).toBe(usageBefore + kept);
      for (const id of versions) {
        const v = getTrackVersionRow(db, id);
        expect(v).toMatchObject({ archivedBy: uploader, archivedReason: "upload" });
        expect(v?.archivedAt).not.toBeNull();
      }
      const events = listEvents(db, { action: "version.lossless_removed" }).filter((e) =>
        versions.includes(e.targetId ?? ""),
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ actorType: "worker", actorUserId: uploader });
      expect(JSON.parse(events[0]?.details ?? "{}")).toMatchObject({
        onUpload: true,
        quality: "high",
        kbps: 128,
      });
      expect(h.events.slice(before)).toContainEqual(
        expect.objectContaining({
          type: "version.lossless_removed",
          songId: song.id,
          data: { versionIds: versions },
        }),
      );
      // A retry never redoes the full quality.
      const again = await runOneJob(h, "audio.ingest", { assetId: asset.id });
      expect(again.status).toBe("done");
      expect(listVariants(db, asset.id).some((v) => v.variant === "flac")).toBe(false);
    },
  );

  it(
    "standard quality follows the audio.opusBitrates setting and keeps the FLAC",
    {
      timeout: 60_000,
    },
    async () => {
      setSetting(db, "audio.opusBitrates", {
        trackStereo: 112,
        trackMono: 72,
        lowStereo: 48,
        lowMono: 32,
      });
      try {
        const { asset, versions } = await versionWith(FLAC_FILE(), {
          lossyOnly: false,
          quality: "standard",
        });
        await runOneJob(h, "audio.ingest", { assetId: asset.id });
        expect(meta(asset.id, "opus")).toMatchObject({ quality: "standard" });
        expect([112, 72]).toContain(meta(asset.id, "opus").bitrate);
        expect(getVariant(db, asset.id, "flac")).toBeTruthy();
        expect(getTrackVersionRow(db, versions[0] ?? "")?.archivedAt).toBeNull();
      } finally {
        setSetting(db, "audio.opusBitrates", {
          trackStereo: 96,
          trackMono: 64,
          lowStereo: 48,
          lowMono: 32,
        });
      }
    },
  );
});
