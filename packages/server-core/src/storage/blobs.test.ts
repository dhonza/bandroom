import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/connection";
import { blobs } from "../db/schema";
import { makeTempDir } from "../testing/tempDir";
import { createTestDb } from "../testing/testDb";
import { addBlobRef, BLOB_GC_GRACE_MS, collectGarbageBlobs, getBlob, storeFile } from "./blobs";
import { LocalStorage } from "./local";

let t: ReturnType<typeof createTestDb>;
let db: Db;
let tmp: ReturnType<typeof makeTempDir>;
let storage: LocalStorage;
let n = 0;
beforeEach(() => {
  t = createTestDb();
  db = t.db;
  tmp = makeTempDir();
  storage = new LocalStorage(path.join(tmp.dir, "blobs"));
});
afterEach(() => {
  t.close();
  tmp.cleanup();
});

async function incoming(content: string): Promise<string> {
  const f = path.join(tmp.dir, `in-${String(n++)}`);
  await fs.writeFile(f, content);
  return f;
}

const fileOf = async (hash: string) =>
  storage.localPath(
    getBlob(db, hash)?.storageKey ?? `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`,
  );
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

describe("blob garbage collection vs. dedupe (review M12)", () => {
  it("collects unreferenced blobs after the grace period only", async () => {
    const b = await storeFile(db, storage, await incoming("a"), undefined, 1000);
    expect((await collectGarbageBlobs(db, storage, 1000 + BLOB_GC_GRACE_MS - 1)).deleted).toBe(0);
    const file = await fileOf(b.hash);
    expect((await collectGarbageBlobs(db, storage, 1001 + BLOB_GC_GRACE_MS)).deleted).toBe(1);
    expect(getBlob(db, b.hash)).toBeUndefined();
    expect(await exists(file)).toBe(false);
  });

  it("limits a run to the given hashes and grace (blob.gc after a purge, SPEC §26.3)", async () => {
    const a = await storeFile(db, storage, await incoming("a"), undefined, 1000);
    const b = await storeFile(db, storage, await incoming("b"), undefined, 1000);
    const c = await storeFile(db, storage, await incoming("c"), undefined, 1000);
    addBlobRef(db, c.hash); // referenced again: never collected
    const opts = { graceMs: 600_000, hashes: [a.hash, c.hash, "missing"] };
    expect((await collectGarbageBlobs(db, storage, 1000 + 599_999, opts)).deleted).toBe(0);
    expect(await collectGarbageBlobs(db, storage, 1000 + 600_000, opts)).toEqual({
      deleted: 1,
      bytes: 1,
    });
    expect(getBlob(db, a.hash)).toBeUndefined();
    expect(getBlob(db, b.hash)).toBeDefined(); // not in the list
    expect(getBlob(db, c.hash)?.refCount).toBe(1);
    // A zero grace collects a blob released in the same millisecond.
    expect(
      (await collectGarbageBlobs(db, storage, 1000, { graceMs: 0, hashes: [b.hash] })).deleted,
    ).toBe(1);
  });

  it("restarts the grace period when identical content is stored again", async () => {
    const b = await storeFile(db, storage, await incoming("a"), undefined, 1000);
    const later = 1000 + BLOB_GC_GRACE_MS + 10;
    await storeFile(db, storage, await incoming("a"), undefined, later);
    expect(getBlob(db, b.hash)?.unreferencedAt).toBe(later);
    expect((await collectGarbageBlobs(db, storage, later + 1)).deleted).toBe(0);
    expect(await exists(await fileOf(b.hash))).toBe(true);
  });

  it("makes storeFile wait while the collector deletes the same content", async () => {
    const b = await storeFile(db, storage, await incoming("a"), undefined, 1000);
    const file = await fileOf(b.hash);
    // A storage whose delete pauses until released, to interleave a concurrent storeFile.
    let release: () => void = () => undefined;
    let paused: () => void = () => undefined;
    const pausedP = new Promise<void>((r) => (paused = r));
    const slow = Object.assign(Object.create(storage) as LocalStorage, {
      delete: async (key: string) => {
        paused();
        await new Promise<void>((r) => (release = r));
        await storage.delete(key);
      },
    });
    const gc = collectGarbageBlobs(db, slow, 1000 + BLOB_GC_GRACE_MS + 1);
    await pausedP;
    expect(() => {
      addBlobRef(db, b.hash);
    }).toThrow(/garbage-collected/);
    let stored = false;
    const store = storeFile(db, storage, await incoming("a")).then((row) => {
      stored = true;
      return row;
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(stored).toBe(false); // waiting for the collector, not deduplicating
    release();
    expect((await gc).deleted).toBe(1);
    const row = await store;
    expect(row).toMatchObject({ hash: b.hash, refCount: 0 });
    expect(await exists(file)).toBe(true); // stored again after the collector removed it
    addBlobRef(db, b.hash);
    expect(getBlob(db, b.hash)?.refCount).toBe(1);
  });

  it("finishes a claim a crashed collector left behind", async () => {
    const b = await storeFile(db, storage, await incoming("a"));
    db.update(blobs).set({ refCount: -1 }).run();
    expect((await collectGarbageBlobs(db, storage)).deleted).toBe(1);
    expect(getBlob(db, b.hash)).toBeUndefined();
  });
});
