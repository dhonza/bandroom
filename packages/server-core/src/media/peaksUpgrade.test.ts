import fs from "node:fs/promises";
import path from "node:path";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/connection";
import { jobs } from "../db/schema";
import { enqueueJob } from "../jobs/queue";
import { storeFile } from "../storage/blobs";
import {
  addOriginal,
  createHarness,
  runOneJob,
  variantPath,
  type Harness,
} from "../testing/ingestHarness";
import { makeTempDir } from "../testing/tempDir";
import { createTestDb } from "../testing/testDb";
import { decodeDat } from "./peaks";
import { assetsWithOldPeaks, enqueuePeaksBackfill } from "./peaksUpgrade";
import { getVariant, putVariant, removeVariant } from "./variants";

let t: ReturnType<typeof createTestDb>;
let db: Db;
let tmp: ReturnType<typeof makeTempDir>;
let h: Harness;

beforeAll(async () => {
  await generateFixtures();
  t = createTestDb();
  db = t.db;
  tmp = makeTempDir();
  h = createHarness(db, tmp.dir);
}, 60_000);
afterAll(() => {
  t.close();
  tmp.cleanup();
});

const meta = (assetId: string) =>
  JSON.parse(getVariant(db, assetId, "peaks")?.meta ?? "null") as Record<string, unknown>;

const queuedPeaksJobs = () =>
  db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, "audio.peaks"), eq(jobs.status, "queued")))
    .all().length;

async function peaksOf(assetId: string) {
  return decodeDat(await fs.readFile(await variantPath(h, assetId, "peaks")));
}

/** An ingested asset whose peaks are swapped for an 8-bit file, as older versions wrote them. */
async function withOldPeaks(): Promise<string> {
  const asset = await addOriginal(h, TONE_FILE());
  expect((await runOneJob(h, "audio.ingest", { assetId: asset.id })).status).toBe("done");
  const fresh = await peaksOf(asset.id);
  const old = Buffer.alloc(20 + fresh.pairs.length);
  old.writeInt32LE(1, 0);
  old.writeUInt32LE(1, 4);
  old.writeInt32LE(fresh.sampleRate, 8);
  old.writeInt32LE(fresh.spp, 12);
  old.writeUInt32LE(fresh.pairs.length / 2, 16);
  fresh.pairs.forEach((v, i) => old.writeInt8(v >> 8, 20 + i));
  const file = path.join(tmp.dir, `old-peaks-${asset.id}.dat`);
  await fs.writeFile(file, old);
  const blob = await storeFile(db, h.storage, file);
  const { bits: _bits, ...rest } = meta(asset.id);
  putVariant(db, asset.id, "peaks", blob.hash, { ...rest, bits: 8 });
  return asset.id;
}

describe("16-bit peaks backfill (audio.peaks)", () => {
  it("ingest writes 16-bit peaks", { timeout: 60_000 }, async () => {
    const asset = await addOriginal(h, TONE_FILE());
    expect((await runOneJob(h, "audio.ingest", { assetId: asset.id })).status).toBe("done");
    expect(meta(asset.id)).toMatchObject({ bits: 16, samplesPerPixel: 256 });
    expect((await peaksOf(asset.id)).bits).toBe(16);
    expect(assetsWithOldPeaks(db)).not.toContain(asset.id);
  });

  it("rewrites 8-bit peaks once, from the best file left", { timeout: 60_000 }, async () => {
    const a = await withOldPeaks();
    const b = await withOldPeaks();
    // b is lossy-only now: the peaks come from its Opus.
    for (const v of ["flac", "original", "wavpack"]) removeVariant(db, b, v);
    const before = meta(a);
    expect(before.bits).toBe(8);
    expect(assetsWithOldPeaks(db).sort()).toEqual([a, b].sort());

    expect(enqueuePeaksBackfill(db)).toBe(2);
    expect(enqueuePeaksBackfill(db)).toBe(2); // deduplicated while queued
    expect(queuedPeaksJobs()).toBe(2);
    db.delete(jobs).where(eq(jobs.type, "audio.peaks")).run();
    expect((await runOneJob(h, "audio.peaks", { assetId: a })).status).toBe("done");
    expect((await runOneJob(h, "audio.peaks", { assetId: b })).status).toBe("done");

    for (const id of [a, b]) {
      const p = await peaksOf(id);
      expect(p.bits).toBe(16);
      expect(meta(id)).toMatchObject({ bits: 16, pixels: p.pairs.length / 2 });
      expect(p.sampleRate).toBe(before.sampleRate);
    }
    expect(meta(a).pixels).toBe(before.pixels);
    expect(meta(a).overview).toEqual(before.overview);
    expect(assetsWithOldPeaks(db)).toEqual([]);
  });

  it("does not queue assets whose rewrite failed again", { timeout: 60_000 }, async () => {
    const id = await withOldPeaks();
    expect(assetsWithOldPeaks(db)).toEqual([id]);
    const job = enqueueJob(db, {
      type: "audio.peaks",
      capability: "audio.peaks",
      payload: { assetId: id },
      dedupeKey: `peaks:${id}`,
    });
    db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, job.id)).run();
    expect(assetsWithOldPeaks(db)).toEqual([]);
  });
});
