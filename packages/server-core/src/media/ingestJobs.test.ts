import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/connection";
import { jobs } from "../db/schema";
import { createTestDb } from "../testing/testDb";
import { enqueueAudioIngest, enqueueProjectImageIngest } from "./ingestJobs";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
});
afterEach(() => {
  close();
});

describe("ingest job helpers", () => {
  it("queues audio.ingest once per asset, with the given priority", () => {
    const input = {
      assetId: "a1",
      role: "track" as const,
      projectId: "p1",
      songId: "s1",
      trackVersionId: "v1",
      createdBy: null,
    };
    enqueueAudioIngest(db, { ...input, priority: -5 });
    enqueueAudioIngest(db, input); // deduplicated while queued
    const rows = db.select().from(jobs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "audio.ingest",
      capability: "audio.ingest",
      dedupeKey: "ingest:a1",
      priority: -5,
    });
    expect(rows[0]?.payload).toBe(
      JSON.stringify({
        assetId: "a1",
        role: "track",
        projectId: "p1",
        songId: "s1",
        trackVersionId: "v1",
      }),
    );
  });

  it("queues a cropped image.ingest for a project image", () => {
    enqueueProjectImageIngest(db, { assetId: "a2", projectId: "p1", createdBy: null });
    const row = db.select().from(jobs).get();
    expect(row).toMatchObject({
      type: "image.ingest",
      capability: "image.ingest",
      dedupeKey: null,
      priority: 0,
    });
    expect(row?.payload).toBe(JSON.stringify({ assetId: "a2", crop: true, projectId: "p1" }));
  });
});
