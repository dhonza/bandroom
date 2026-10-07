import { FLAC_FILE, generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertUser } from "../auth/users";
import { createProjectRow } from "../content/projects";
import { createSongRow } from "../content/songs";
import { addTrackVersion, createTrackWithVersion, getTrackVersionRow } from "../content/tracks";
import type { Db } from "../db/connection";
import { listEvents } from "../events/record";
import { getJob } from "../jobs/queue";
import { getBlob } from "../storage/blobs";
import { addOriginal, createHarness, runOneJob, type Harness } from "../testing/ingestHarness";
import { makeTempDir } from "../testing/tempDir";
import { createTestDb } from "../testing/testDb";
import { readOggOpus } from "./ogg";
import { getUsage, getVariant, listVariants, removeVariant } from "./variants";
import { variantPath } from "../testing/ingestHarness";

let t: ReturnType<typeof createTestDb>;
let db: Db;
let tmp: ReturnType<typeof makeTempDir>;
let h: Harness;
let uploader: string;
let manager: string;

beforeAll(async () => {
  await generateFixtures();
  t = createTestDb();
  db = t.db;
  tmp = makeTempDir();
  h = createHarness(db, tmp.dir);
  const user = (username: string) =>
    insertUser(db, { username, displayName: username, passwordHash: "x", globalRole: "member" }).id;
  uploader = user("up");
  manager = user("boss");
}, 60_000);
afterAll(() => {
  t.close();
  tmp.cleanup();
});

/** An ingested file on a track, plus a copy (a second version using the same asset). */
async function ingested(file: string) {
  const asset = await addOriginal(h, file, uploader);
  const { status } = await runOneJob(h, "audio.ingest", { assetId: asset.id });
  expect(status).toBe("done");
  const project = createProjectRow(db, { name: "P", createdBy: uploader });
  const song = createSongRow(db, { projectId: project.id, title: "S", createdBy: uploader });
  const { track, version } = createTrackWithVersion(db, {
    songId: song.id,
    name: "Bass",
    assetId: asset.id,
    uploadedBy: uploader,
  });
  const copy = addTrackVersion(db, { trackId: track.id, assetId: asset.id, uploadedBy: uploader });
  return {
    assetId: asset.id,
    projectId: project.id,
    songId: song.id,
    versions: [version.id, copy.id],
  };
}

const meta = (assetId: string, variant: string) =>
  JSON.parse(getVariant(db, assetId, variant)?.meta ?? "null") as Record<string, unknown>;

const reencode = (a: { assetId: string; projectId: string; songId: string }, quality: string) =>
  runOneJob(h, "audio.reencode", {
    assetId: a.assetId,
    projectId: a.projectId,
    songId: a.songId,
    trackVersionId: null,
    quality,
    userId: manager,
  });

describe("audio.reencode (SPEC §28.3)", () => {
  it(
    "swaps in Opus at the new quality, then removes full quality and archives every copy",
    {
      timeout: 60_000,
    },
    async () => {
      const a = await ingested(TONE_FILE());
      const before = getVariant(db, a.assetId, "opus");
      const oldBlob = getBlob(db, before?.blobHash ?? "");
      const lowBefore = getVariant(db, a.assetId, "opus_low")?.blobHash;
      const usage = getUsage(db, uploader);
      const flacSize =
        getBlob(db, getVariant(db, a.assetId, "flac")?.blobHash ?? "")?.sizeBytes ?? 0;
      const wavmetaSize =
        getBlob(db, getVariant(db, a.assetId, "wavmeta")?.blobHash ?? "")?.sizeBytes ?? 0;
      const seekFlacSize =
        getBlob(db, getVariant(db, a.assetId, "seekindex_flac")?.blobHash ?? "")?.sizeBytes ?? 0;
      const seekBefore =
        getBlob(db, getVariant(db, a.assetId, "seekindex_opus")?.blobHash ?? "")?.sizeBytes ?? 0;
      const emitted = h.events.length;

      const { status, job } = await reencode(a, "high");
      expect(getJob(db, job.id)?.error ?? null).toBeNull();
      expect(status).toBe("done");

      const after = getVariant(db, a.assetId, "opus");
      expect(after?.blobHash).not.toBe(before?.blobHash);
      expect(meta(a.assetId, "opus")).toMatchObject({ bitrate: 128, quality: "high", channels: 2 });
      const info = await readOggOpus(await variantPath(h, a.assetId, "opus"));
      expect(info.totalSamples).toBe(meta(a.assetId, "opus").durationSamples48k);
      expect(getVariant(db, a.assetId, "opus_low")?.blobHash).toBe(lowBefore);
      expect(
        listVariants(db, a.assetId)
          .map((v) => v.variant)
          .sort(),
      ).toEqual(["opus", "opus_low", "peaks", "seekindex_opus", "seekindex_opus_low"]);
      const newSize = getBlob(db, after?.blobHash ?? "")?.sizeBytes ?? 0;
      const seekAfter =
        getBlob(db, getVariant(db, a.assetId, "seekindex_opus")?.blobHash ?? "")?.sizeBytes ?? 0;
      expect(getUsage(db, uploader)).toBe(
        usage -
          flacSize -
          wavmetaSize -
          seekFlacSize -
          (oldBlob?.sizeBytes ?? 0) +
          newSize -
          seekBefore +
          seekAfter,
      );
      for (const id of a.versions) {
        expect(getTrackVersionRow(db, id)).toMatchObject({
          archivedBy: manager,
          archivedReason: "reencode",
        });
      }
      const ofAsset = (action: "version.reencoded" | "version.lossless_removed") =>
        listEvents(db, { action }).filter((e) => a.versions.includes(e.targetId ?? ""));
      expect(ofAsset("version.reencoded")).toHaveLength(2);
      expect(ofAsset("version.lossless_removed")).toHaveLength(2);
      expect(ofAsset("version.reencoded")[0]).toMatchObject({
        actorType: "worker",
        actorUserId: manager,
      });
      expect(JSON.parse(ofAsset("version.reencoded")[0]?.details ?? "{}")).toMatchObject({
        quality: "high",
        kbps: 128,
        previousKbps: 96,
      });
      expect(h.events.slice(emitted)).toContainEqual(
        expect.objectContaining({ type: "version.lossless_removed", songId: a.songId }),
      );
    },
  );

  it(
    "leaves the asset untouched when there is no full-quality source",
    {
      timeout: 60_000,
    },
    async () => {
      const a = await ingested(FLAC_FILE());
      removeVariant(db, a.assetId, "flac");
      removeVariant(db, a.assetId, "original");
      const opus = getVariant(db, a.assetId, "opus")?.blobHash;
      const { status } = await reencode(a, "low");
      expect(status).toBe("failed");
      expect(getVariant(db, a.assetId, "opus")?.blobHash).toBe(opus);
      expect(getTrackVersionRow(db, a.versions[0] ?? "")?.archivedAt).toBeNull();
    },
  );
});
