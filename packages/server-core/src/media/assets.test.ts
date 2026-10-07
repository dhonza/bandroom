import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/connection";
import { blobs } from "../db/schema";
import { getBlob } from "../storage/blobs";
import { createTestDb } from "../testing/testDb";
import { createOriginalAsset, getAsset } from "./assets";
import { getVariant } from "./variants";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
});
afterEach(() => {
  close();
});

describe("createOriginalAsset", () => {
  it("creates the asset with the stored blob as its original variant", () => {
    const hash = "a".repeat(64);
    db.insert(blobs).values({ hash, sizeBytes: 42, storageKey: "k", createdAt: 1 }).run();
    const asset = createOriginalAsset(
      db,
      {
        kind: "document",
        originalFilename: "notes.md",
        sizeBytes: 42,
        originalHash: hash,
        uploadedBy: null,
      },
      { hash, sizeBytes: 42 },
      1000,
    );
    expect(getAsset(db, asset.id)).toMatchObject({ status: "queued", createdAt: 1000 });
    const original = getVariant(db, asset.id, "original");
    expect(original).toMatchObject({ blobHash: hash, createdAt: 1000 });
    expect(JSON.parse(original?.meta ?? "{}")).toEqual({ size: 42 });
    expect(getBlob(db, hash)?.refCount).toBe(1);
  });
});
