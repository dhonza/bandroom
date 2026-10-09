import { randomBytes } from "node:crypto";
import { FLOAT_FILE, generateFixtures, MP3_FILE, TONE_FILE } from "@bandroom/fixtures";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertUser } from "../auth/users";
import type { Db } from "../db/connection";
import { blobs, jobs, trackVersions } from "../db/schema";
import { createAsset, getAsset, setAssetStatus } from "../media/assets";
import { getUsage, listVariants, putVariant } from "../media/variants";
import { setSetting } from "../settings/registry";
import { getBlob } from "../storage/blobs";
import { addOriginal, createHarness, runOneJob, type Harness } from "../testing/ingestHarness";
import { makeTempDir } from "../testing/tempDir";
import { createTestDb } from "../testing/testDb";
import {
  applyLosslessRemoval,
  assetLosslessRemoved,
  lossyBySong,
  ownsAllVersions,
  planLosslessRemoval,
} from "./lossless";
import { createProjectRow } from "./projects";
import { createSongRow } from "./songs";
import { addTrackVersion, createTrackWithVersion } from "./tracks";

let t: ReturnType<typeof createTestDb>;
let db: Db;
let tmp: ReturnType<typeof makeTempDir>;
let h: Harness;
let userId: string;
let otherId: string;
let projectId: string;

beforeAll(async () => {
  await generateFixtures();
  t = createTestDb();
  db = t.db;
  tmp = makeTempDir();
  h = createHarness(db, tmp.dir);
  userId = insertUser(db, {
    username: "u",
    displayName: "U",
    passwordHash: "x",
    globalRole: "member",
  }).id;
  otherId = insertUser(db, {
    username: "o",
    displayName: "O",
    passwordHash: "x",
    globalRole: "member",
  }).id;
  projectId = createProjectRow(db, { name: "P", createdBy: userId }).id;
}, 60_000);
afterAll(() => {
  t.close();
  tmp.cleanup();
});

const newSong = () => createSongRow(db, { projectId, title: "S", createdBy: userId }).id;

async function addTrack(songId: string, file: string, name: string) {
  const asset = await addOriginal(h, file, userId);
  const { track, version } = createTrackWithVersion(db, {
    songId,
    name,
    assetId: asset.id,
    uploadedBy: userId,
  });
  const { status } = await runOneJob(h, "audio.ingest", { assetId: asset.id });
  expect(status).toBe("done");
  return { track, version, assetId: asset.id };
}

const names = (assetId: string) =>
  listVariants(db, assetId)
    .map((v) => v.variant)
    .sort();

describe("remove full quality (SPEC §26.4)", () => {
  it(
    "removes flac, original and wavmeta, keeps Opus and peaks, frees usage",
    { timeout: 120_000 },
    async () => {
      const songId = newSong();
      const wav = await addTrack(songId, TONE_FILE(), "Tone");
      const mp3 = await addTrack(songId, MP3_FILE(), "Demo");
      expect(lossyBySong(db, projectId).get(songId)).toBe("partial");
      const flacHash = listVariants(db, wav.assetId).find((v) => v.variant === "flac")?.blobHash;
      const usage = getUsage(db, userId);

      const plan = planLosslessRemoval(db, [{ kind: "song", id: songId }]);
      expect(plan.preview).toMatchObject({
        versions: 2,
        files: { flac: 1, original: 1, wavmeta: 1, wavpack: 0 },
        lossySources: { count: 1, items: [{ id: mp3.version.id, trackName: "Demo" }] },
        sharedCopies: 0,
        skipped: { notReady: 0, alreadyLossy: 0 },
      });
      expect(plan.preview.bytesFreed).toBe(plan.preview.usageBytes);

      const archived = db.transaction(() => applyLosslessRemoval(db, plan, userId, 5000));
      expect(archived.map((a) => a.versionId).sort()).toEqual(
        [wav.version.id, mp3.version.id].sort(),
      );
      expect(names(wav.assetId)).toEqual([
        "opus",
        "opus_low",
        "peaks",
        "seekindex_opus",
        "seekindex_opus_low",
      ]);
      expect(names(mp3.assetId)).not.toContain("original");
      expect(getUsage(db, userId)).toBe(usage - plan.preview.usageBytes);
      expect(getBlob(db, flacHash ?? "")?.refCount).toBe(0);
      expect(
        db.select().from(trackVersions).where(eq(trackVersions.id, wav.version.id)).get(),
      ).toMatchObject({ archivedAt: 5000, archivedBy: userId });
      expect(lossyBySong(db, projectId).get(songId)).toBe("all");

      // A second run finds nothing left to remove.
      expect(planLosslessRemoval(db, [{ kind: "song", id: songId }]).preview).toMatchObject({
        versions: 0,
        skipped: { alreadyLossy: 2 },
      });

      // Ingest never recreates the files (e.g. a stray re-run).
      expect(assetLosslessRemoved(db, wav.assetId)).toBe(true);
      const again = await runOneJob(h, "audio.ingest", { assetId: wav.assetId });
      expect(again.status).toBe("done");
      expect(db.select().from(jobs).where(eq(jobs.id, again.job.id)).get()?.result).toMatch(
        /full quality was removed/,
      );
      expect(names(wav.assetId)).not.toContain("flac");
      expect(getAsset(db, wav.assetId)?.status).toBe("ready");
    },
  );

  it("removes the WavPack of a float source too", { timeout: 60_000 }, async () => {
    const songId = newSong();
    const float = await addTrack(songId, FLOAT_FILE(), "Float");
    expect(names(float.assetId)).toContain("wavpack");
    const plan = planLosslessRemoval(db, [{ kind: "version", id: float.version.id }]);
    expect(plan.preview.files).toEqual({ flac: 1, original: 0, wavmeta: 1, wavpack: 1 });
    db.transaction(() => applyLosslessRemoval(db, plan, userId));
    expect(names(float.assetId)).toEqual([
      "opus",
      "opus_low",
      "peaks",
      "seekindex_opus",
      "seekindex_opus_low",
    ]);
  });

  it("counts shared copies, archives them too, and skips versions not ready", async () => {
    const songId = newSong();
    const wav = await addTrack(songId, TONE_FILE(), "Tone");
    // A copy elsewhere shares the asset (SPEC §26.6); a processing version is skipped.
    const other = newSong();
    const copy = createTrackWithVersion(db, {
      songId: other,
      name: "Tone copy",
      assetId: wav.assetId,
      uploadedBy: userId,
    });
    const pending = await addOriginal(h, TONE_FILE(), otherId);
    addTrackVersion(db, { trackId: wav.track.id, assetId: pending.id, uploadedBy: otherId });
    expect(getAsset(db, pending.id)?.status).not.toBe("ready");
    expect(ownsAllVersions(db, "track", wav.track.id, userId)).toBe(false);
    expect(ownsAllVersions(db, "version", wav.version.id, userId)).toBe(true);

    const plan = planLosslessRemoval(db, [
      { kind: "track", id: wav.track.id },
      { kind: "version", id: wav.version.id },
    ]);
    expect(plan.preview).toMatchObject({
      versions: 1,
      sharedCopies: 1,
      skipped: { notReady: 1, alreadyLossy: 0 },
    });
    const archived = db.transaction(() => applyLosslessRemoval(db, plan, userId));
    expect(archived.find((a) => a.versionId === copy.version.id)).toMatchObject({ copy: true });
    expect(archived.find((a) => a.versionId === wav.version.id)).toMatchObject({ copy: false });
    expect(lossyBySong(db, projectId).get(other)).toBe("all");
  });
});

describe("remove full quality preview: current Opus (SPEC §28.3)", () => {
  /** A ready FLAC asset with an Opus of `kbps` and `channels` (fake blobs, no files). */
  function fakeTrack(songId: string, kbps: number, channels: 1 | 2) {
    const blob = (size: number) => {
      const hash = randomBytes(32).toString("hex");
      db.insert(blobs)
        .values({ hash, sizeBytes: size, storageKey: `x/${hash}`, refCount: 0, createdAt: 0 })
        .run();
      return hash;
    };
    const asset = createAsset(db, {
      kind: "audio",
      originalFilename: "x.wav",
      sizeBytes: 1,
      originalHash: randomBytes(32).toString("hex"),
      uploadedBy: userId,
    });
    putVariant(db, asset.id, "flac", blob(1000));
    putVariant(db, asset.id, "opus", blob(100), { bitrate: kbps, channels });
    setAssetStatus(db, asset.id, "ready");
    createTrackWithVersion(db, { songId, name: "T", assetId: asset.id, uploadedBy: userId });
  }

  it("groups by bitrate and channels and names the preset", () => {
    const songId = newSong();
    fakeTrack(songId, 96, 2);
    fakeTrack(songId, 96, 2);
    fakeTrack(songId, 64, 1);
    fakeTrack(songId, 64, 2);
    fakeTrack(songId, 100, 2);
    const { currentOpus } = planLosslessRemoval(db, [{ kind: "song", id: songId }]).preview;
    expect(currentOpus).toEqual([
      { kbps: 96, count: 2, channels: 2, quality: "standard" },
      { kbps: 100, count: 1, channels: 2, quality: null },
      { kbps: 64, count: 1, channels: 2, quality: "low" },
      { kbps: 64, count: 1, channels: 1, quality: "standard" },
    ]);
  });

  it("names standard by the audio.opusBitrates setting", () => {
    const songId = newSong();
    fakeTrack(songId, 112, 2);
    fakeTrack(songId, 96, 2);
    setSetting(db, "audio.opusBitrates", {
      trackStereo: 112,
      trackMono: 72,
      lowStereo: 48,
      lowMono: 32,
    });
    try {
      const { currentOpus } = planLosslessRemoval(db, [{ kind: "song", id: songId }]).preview;
      expect(currentOpus).toEqual([
        { kbps: 112, count: 1, channels: 2, quality: "standard" },
        { kbps: 96, count: 1, channels: 2, quality: null },
      ]);
    } finally {
      setSetting(db, "audio.opusBitrates", {
        trackStereo: 96,
        trackMono: 64,
        lowStereo: 48,
        lowMono: 32,
      });
    }
  });
});
