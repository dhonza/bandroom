import { generateFixtures, MP3_FILE, TONE_FILE } from "@bandroom/fixtures";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertUser } from "../auth/users";
import type { Db } from "../db/connection";
import { jobs, trackVersions } from "../db/schema";
import { getAsset } from "../media/assets";
import { getUsage, listVariants } from "../media/variants";
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
import { addTrackVersion, createTrackWithVersion, listenSource } from "./tracks";

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
    role: "track",
    assetId: asset.id,
    uploadedBy: userId,
  });
  const { status } = await runOneJob(h, "audio.ingest", { assetId: asset.id, role: "track" });
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
        files: { flac: 1, original: 1, wavmeta: 1 },
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

      // Ingest never recreates the files (e.g. a stray re-run), and the mix still uses Opus.
      expect(assetLosslessRemoved(db, wav.assetId)).toBe(true);
      const again = await runOneJob(h, "audio.ingest", { assetId: wav.assetId, role: "track" });
      expect(again.status).toBe("done");
      expect(db.select().from(jobs).where(eq(jobs.id, again.job.id)).get()?.result).toMatch(
        /full quality was removed/,
      );
      expect(names(wav.assetId)).not.toContain("flac");
      expect(getAsset(db, wav.assetId)?.status).toBe("ready");
      const mix = await runOneJob(h, "audio.mixdown", { songId });
      expect(mix.status).toBe("done");
      expect(
        JSON.parse(db.select().from(jobs).where(eq(jobs.id, mix.job.id)).get()?.result ?? "{}"),
      ).toMatchObject({ status: "rendered", inputs: 2 });
      expect(listenSource(db, songId)?.isAutoMix).toBe(true);
    },
  );

  it("counts shared copies, archives them too, and skips versions not ready", async () => {
    const songId = newSong();
    const wav = await addTrack(songId, TONE_FILE(), "Tone");
    // A copy elsewhere shares the asset (SPEC §26.6); a processing version is skipped.
    const other = newSong();
    const copy = createTrackWithVersion(db, {
      songId: other,
      name: "Tone copy",
      role: "track",
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
