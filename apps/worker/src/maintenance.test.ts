import fs from "node:fs";
import path from "node:path";
import {
  createAsset,
  createProjectRow,
  createSongRow,
  createTestDb,
  createTrackWithVersion,
  getUsage,
  insertUser,
  listEvents,
  LocalStorage,
  makeTempDir,
  putVariant,
  schema,
  setSetting,
  softDeleteProject,
  softDeleteTrack,
  storeFile,
} from "@bandroom/server-core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lastMaintenanceRun,
  localDate,
  MAINTENANCE_RETRY_MS,
  maintenanceDue,
  maintenanceTick,
  purgeExpiredTrash,
  runMaintenance,
} from "./maintenance";

describe("maintenance schedule", () => {
  it("runs once per day after 04:00 server time", () => {
    const d = (h: number, day = 28) => new Date(2026, 8, day, h, 30);
    expect(maintenanceDue(d(3), null)).toBe(false);
    expect(maintenanceDue(d(4), null)).toBe(true);
    expect(maintenanceDue(d(23), localDate(d(4)))).toBe(false);
    expect(maintenanceDue(d(5, 29), localDate(d(4)))).toBe(true);
    expect(localDate(d(4))).toBe("2026-09-28");
  });
});

describe("maintenanceTick", () => {
  let t: ReturnType<typeof createTestDb>;
  let root: ReturnType<typeof makeTempDir>;
  let storage: LocalStorage;
  beforeEach(() => {
    t = createTestDb();
    root = makeTempDir();
    storage = new LocalStorage(root.dir);
  });
  afterEach(() => {
    t.close();
    root.cleanup();
  });

  const at = (h: number, min = 0) => new Date(2026, 9, 1, h, min);
  const logger = () => {
    const lines: { level: "info" | "error"; msg: string; obj: object }[] = [];
    return {
      lines,
      log: {
        info: (obj: object, msg: string) => lines.push({ level: "info", msg, obj }),
        error: (obj: object, msg: string) => lines.push({ level: "error", msg, obj }),
      },
    };
  };

  it("logs a failure instead of throwing and backs off for an hour", async () => {
    const { lines, log } = logger();
    const state = { retryAfter: 0 };
    const run = vi.fn<typeof runMaintenance>(() => Promise.reject(new Error("disk on fire")));
    const deps = { db: t.db, storage, log, state, run };

    await expect(maintenanceTick(deps, at(4, 10))).resolves.toBe("failed");
    expect(run).toHaveBeenCalledTimes(1);
    expect(lines).toMatchObject([{ level: "error", msg: "daily maintenance failed" }]);
    expect(state.retryAfter).toBe(at(4, 10).getTime() + MAINTENANCE_RETRY_MS);

    // Still due, but within the back-off: no new attempt.
    expect(await maintenanceTick(deps, at(4, 50))).toBe("idle");
    expect(run).toHaveBeenCalledTimes(1);
    expect(lastMaintenanceRun(t.db)).toBeNull();

    // After the back-off it tries again.
    run.mockImplementation(() => runMaintenance(t.db, storage, at(5, 11)));
    expect(await maintenanceTick(deps, at(5, 11))).toBe("done");
    expect(run).toHaveBeenCalledTimes(2);
    expect(lastMaintenanceRun(t.db)).toBe("2026-10-01");
  });

  it("runs the real maintenance once a day when due", async () => {
    const { lines, log } = logger();
    const deps = { db: t.db, storage, log, state: { retryAfter: 0 } };
    expect(await maintenanceTick(deps, at(3))).toBe("idle");
    expect(await maintenanceTick(deps, at(4, 1))).toBe("done");
    expect(lines).toMatchObject([
      { level: "info", msg: "daily maintenance done", obj: { blobsDeleted: 0 } },
    ]);
    expect(await maintenanceTick(deps, at(9))).toBe("idle");
    expect(lines).toHaveLength(1);
  });
});

describe("Trash purge after the retention period (SPEC §26.3)", () => {
  let t: ReturnType<typeof createTestDb>;
  let root: ReturnType<typeof makeTempDir>;
  let storage: LocalStorage;
  beforeEach(() => {
    t = createTestDb();
    root = makeTempDir();
    storage = new LocalStorage(root.dir);
  });
  afterEach(() => {
    t.close();
    root.cleanup();
  });

  const DAY = 24 * 3600 * 1000;
  const now = new Date(2026, 9, 10, 4, 30).getTime();

  /** A version with a real stored blob (so the GC can delete its file). */
  async function seed(userId: string, songId: string, name: string, content: string) {
    const file = path.join(root.dir, `${name}.tmp`);
    fs.writeFileSync(file, content);
    const b = await storeFile(t.db, storage, file, undefined, now - 40 * DAY);
    const a = createAsset(t.db, {
      kind: "audio",
      originalFilename: `${name}.wav`,
      sizeBytes: b.sizeBytes,
      originalHash: b.hash,
      uploadedBy: userId,
    });
    putVariant(t.db, a.id, "flac", b.hash);
    return createTrackWithVersion(t.db, {
      songId,
      name,
      assetId: a.id,
      uploadedBy: userId,
    });
  }

  it("purges items deleted longer ago than trash.retentionDays, then the GC frees the files", async () => {
    const user = insertUser(t.db, {
      username: "u",
      displayName: "U",
      globalRole: "member",
      passwordHash: "x",
    });
    const project = createProjectRow(t.db, { name: "P", createdBy: user.id });
    const song = createSongRow(t.db, { projectId: project.id, title: "S", createdBy: user.id });
    const old = await seed(user.id, song.id, "old", "old audio");
    const recent = await seed(user.id, song.id, "recent", "recent audio!");
    softDeleteTrack(t.db, old.track.id, now - 31 * DAY, user.id);
    softDeleteTrack(t.db, recent.track.id, now - 29 * DAY, user.id);
    const usage = getUsage(t.db, user.id);

    expect(purgeExpiredTrash(t.db, now)).toEqual({ purged: 1, bytesFreed: 9 });
    const events = listEvents(t.db, { action: "track.purged" });
    expect(events.map((e) => [e.targetId, e.actorType])).toEqual([[old.track.id, "system"]]);
    expect(JSON.parse(events[0]?.details ?? "{}")).toMatchObject({ auto: true, name: "old" });
    expect(getUsage(t.db, user.id)).toBe(usage - 9);
    // Nothing left to purge; a shorter retention reaches the other track.
    expect(purgeExpiredTrash(t.db, now)).toEqual({ purged: 0, bytesFreed: 0 });
    setSetting(t.db, "trash.retentionDays", 7);
    expect(purgeExpiredTrash(t.db, now).purged).toBe(1);

    // The blobs were released now; the GC deletes them after its grace period.
    const res = await runMaintenance(t.db, storage, new Date(now + 2 * DAY));
    expect(res).toMatchObject({ trashPurged: 0, blobsDeleted: 2 });
  });

  it("also purges deleted projects (by their deletedAt) and documents in live projects", async () => {
    const user = insertUser(t.db, {
      username: "u",
      displayName: "U",
      globalRole: "member",
      passwordHash: "x",
    });
    // A project deleted long ago, before projects were part of the Trash: purged on the first run.
    const gone = createProjectRow(t.db, { name: "Old album", createdBy: user.id });
    const goneSong = createSongRow(t.db, { projectId: gone.id, title: "S", createdBy: user.id });
    await seed(user.id, goneSong.id, "a", "old project audio");
    softDeleteProject(t.db, gone.id, now - 200 * DAY);
    const recent = createProjectRow(t.db, { name: "Recent", createdBy: user.id });
    softDeleteProject(t.db, recent.id, now - 2 * DAY, user.id);
    // A document deleted 31 days ago in a live project.
    const live = createProjectRow(t.db, { name: "Live", createdBy: user.id });
    const docId = "doc-old";
    t.db
      .insert(schema.documents)
      .values({
        id: docId,
        projectId: live.id,
        title: "Lyrics",
        kind: "text",
        createdBy: user.id,
        createdAt: 1,
        deletedAt: now - 31 * DAY,
      })
      .run();
    const usage = getUsage(t.db, user.id);

    expect(purgeExpiredTrash(t.db, now)).toMatchObject({ purged: 2 });
    const byId = (id: string) =>
      t.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    expect(byId(gone.id)).toBeUndefined();
    expect(byId(recent.id)?.deletedAt).toBe(now - 2 * DAY);
    expect(t.db.select().from(schema.songs).where(eq(schema.songs.id, goneSong.id)).get()).toBe(
      undefined,
    );
    expect(
      t.db.select().from(schema.documents).where(eq(schema.documents.id, docId)).get(),
    ).toBeUndefined();
    expect(getUsage(t.db, user.id)).toBeLessThan(usage);
    expect(
      listEvents(t.db, { action: "project.purged" }).map((e) => [e.targetId, e.actorType]),
    ).toEqual([[gone.id, "system"]]);
    expect(listEvents(t.db, { action: "document.purged" })).toHaveLength(1);
  });
});
