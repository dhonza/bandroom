import fs from "node:fs";
import path from "node:path";
import {
  createAsset,
  createSongRow,
  createTrackWithVersion,
  LocalStorage,
  putVariant,
  schema,
  setAssetStatus,
  storeFile,
} from "@bandroom/server-core";
import { batchDelete, batchPurge, createProject } from "@bandroom/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  createTestApp,
  loginAs,
  runQueuedJobs,
  seedUser,
  type TestApp,
} from "../testing/testApp";

let t: TestApp;
let admin: string;
let adminId: string;

beforeAll(async () => {
  // No grace, so the test can run the purge's blob.gc job at once.
  t = await createTestApp({ PURGE_GC_GRACE_SECONDS: "0" });
  adminId = (await seedUser(t, "boss", "admin")).id;
  admin = await loginAs(t, "boss");
});
afterAll(async () => {
  await t.close();
});

/** A stored blob with a real file in the app's blob directory. */
async function realBlob(content: string) {
  const storage = new LocalStorage(path.join(t.dataDir, "blobs"));
  const file = path.join(t.dataDir, `tmp-${String(Date.now())}-${content}`);
  fs.writeFileSync(file, content);
  const b = await storeFile(t.db, storage, file);
  return { hash: b.hash, file: path.join(t.dataDir, "blobs", b.storageKey) };
}

describe("Delete permanently frees the disk within minutes (SPEC §26.3)", () => {
  it("enqueues blob.gc for the released files; running it deletes them, shared ones stay", async () => {
    const projectId = (await call(t, createProject, { body: { name: "Album" } }, admin)).json<{
      project: { id: string };
    }>().project.id;
    const songId = createSongRow(t.db, { projectId, title: "Gone", createdBy: adminId }).id;
    const own = await realBlob("own audio");
    const shared = await realBlob("shared audio");
    const a = createAsset(t.db, {
      kind: "audio",
      originalFilename: "x.wav",
      sizeBytes: 1,
      originalHash: own.hash,
      uploadedBy: adminId,
    });
    putVariant(t.db, a.id, "flac", own.hash);
    putVariant(t.db, a.id, "opus", shared.hash);
    setAssetStatus(t.db, a.id, "ready");
    // Another asset (a dedupe twin) still uses the shared blob.
    const twin = createAsset(t.db, {
      kind: "audio",
      originalFilename: "y.wav",
      sizeBytes: 1,
      originalHash: shared.hash,
      uploadedBy: adminId,
    });
    putVariant(t.db, twin.id, "opus", shared.hash);
    createTrackWithVersion(t.db, {
      songId,
      name: "Bass",
      role: "track",
      assetId: a.id,
      uploadedBy: adminId,
    });
    expect(fs.existsSync(own.file)).toBe(true);

    await call(t, batchDelete, { body: { songs: [songId] } }, admin);
    expect((await call(t, batchPurge, { body: { songs: [songId] } }, admin)).statusCode).toBe(200);
    const jobs = t.db.select().from(schema.jobs).where(eq(schema.jobs.type, "blob.gc")).all();
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0]?.payload ?? "{}")).toMatchObject({ graceMs: 0 });

    expect(await runQueuedJobs(t)).toEqual(["done"]);
    expect(fs.existsSync(own.file)).toBe(false);
    expect(t.db.select().from(schema.blobs).where(eq(schema.blobs.hash, own.hash)).get()).toBe(
      undefined,
    );
    // Still referenced by the twin: kept.
    expect(fs.existsSync(shared.file)).toBe(true);
    expect(
      t.db.select().from(schema.blobs).where(eq(schema.blobs.hash, shared.hash)).get()?.refCount,
    ).toBe(1);
  });
});
