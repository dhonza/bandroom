import { randomBytes } from "node:crypto";
import {
  addTrackVersion,
  createAsset,
  createSongRow,
  createTrackWithVersion,
  getUsage,
  listEvents,
  putVariant,
  schema,
  setAssetStatus,
  setProjectGrantRow,
} from "@bandroom/server-core";
import {
  ApiErrorSchema,
  batchDelete,
  batchPurge,
  batchRestore,
  createComment,
  createProject,
  deleteSong,
  listAdminTrash,
  listProjectTrash,
  TrashListSchema,
  type StreamEvent,
  type TrashItem,
} from "@bandroom/shared";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "../testing/testApp";

let t: TestApp;
let admin: string;
let manager: string;
let editor: string;
let member: string; // contributor by the instance default
let guest: string;
const ids: Record<string, string> = {};
const published: StreamEvent[] = [];

const codeOf = (res: LightMyRequestResponse) =>
  res.statusCode >= 400 ? ApiErrorSchema.parse(res.json()).code : "ok";
const paramsOf = (res: LightMyRequestResponse) => ApiErrorSchema.parse(res.json()).params;

/** Stores a fake blob of `size` bytes (no file; GC is not exercised here). */
function blob(size: number): string {
  const hash = randomBytes(32).toString("hex");
  t.db
    .insert(schema.blobs)
    .values({ hash, sizeBytes: size, storageKey: `x/${hash}`, refCount: 0, createdAt: 0 })
    .run();
  return hash;
}

/** A ready audio asset with flac (1000 B) and opus (100 B) variants. */
function asset(uploadedBy: string): string {
  const a = createAsset(t.db, {
    kind: "audio",
    originalFilename: "x.wav",
    sizeBytes: 1,
    originalHash: randomBytes(32).toString("hex"),
    uploadedBy,
  });
  putVariant(t.db, a.id, "flac", blob(1000));
  putVariant(t.db, a.id, "opus", blob(100));
  setAssetStatus(t.db, a.id, "ready");
  return a.id;
}

function track(songId: string, name: string, by: string, versions = 1) {
  const created = createTrackWithVersion(t.db, {
    songId,
    name,
    assetId: asset(by),
    uploadedBy: by,
  });
  const versionIds = [created.version.id];
  for (let i = 1; i < versions; i++) {
    versionIds.push(
      addTrackVersion(t.db, { trackId: created.track.id, assetId: asset(by), uploadedBy: by }).id,
    );
  }
  return { trackId: created.track.id, versionIds };
}

const trashOf = async (cookie: string, projectId = ids.project ?? "") =>
  TrashListSchema.parse(
    (await call(t, listProjectTrash, { params: { id: projectId } }, cookie)).json(),
  );
const row = (table: "songs" | "tracks" | "track_versions", id: string) =>
  t.db.$client.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
    | { deleted_at: number | null; deleted_by: string | null; current_version_id?: string | null }
    | undefined;

beforeAll(async () => {
  t = await createTestApp();
  const boss = await seedUser(t, "boss", "admin");
  const mara = await seedUser(t, "mara", "member");
  const eda = await seedUser(t, "eda", "member");
  const petr = await seedUser(t, "petr", "member");
  await seedUser(t, "host", "guest");
  ids.boss = boss.id;
  ids.mara = mara.id;
  ids.eda = eda.id;
  ids.petr = petr.id;
  admin = await loginAs(t, "boss");
  manager = await loginAs(t, "mara");
  editor = await loginAs(t, "eda");
  member = await loginAs(t, "petr");
  guest = await loginAs(t, "host");
  ids.project = (await call(t, createProject, { body: { name: "Album" } }, admin)).json<{
    project: { id: string };
  }>().project.id;
  setProjectGrantRow(t.db, ids.project, mara.id, "manager", boss.id);
  setProjectGrantRow(t.db, ids.project, eda.id, "editor", boss.id);
  t.hub.subscribe({ canSee: () => true, send: () => undefined }, null);
  const publish = t.hub.publish.bind(t.hub);
  t.hub.publish = (e, now) => {
    published.push(e);
    return publish(e, now);
  };
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  published.length = 0;
});

const newSong = (title: string) =>
  createSongRow(t.db, { projectId: ids.project ?? "", title, createdBy: ids.boss ?? "" }).id;

describe("batch delete (SPEC §26.2)", () => {
  it("validates the body: 1 to 500 ids", async () => {
    expect(codeOf(await call(t, batchDelete, { body: {} }, admin))).toBe("VALIDATION_FAILED");
    const many = Array.from({ length: 501 }, (_, i) => `id${String(i)}`);
    expect(codeOf(await call(t, batchDelete, { body: { versions: many } }, admin))).toBe(
      "VALIDATION_FAILED",
    );
    expect(codeOf(await call(t, batchDelete, { body: { songs: ["x"] } }))).toBe("UNAUTHENTICATED");
  });

  it("is all or nothing: one forbidden item stops the batch and names it", async () => {
    const songId = newSong("Mixed");
    const mine = track(songId, "Mine", ids.petr ?? "", 2);
    const theirs = track(songId, "Theirs", ids.eda ?? "");
    const res = await call(
      t,
      batchDelete,
      { body: { versions: [...mine.versionIds, ...theirs.versionIds] } },
      member,
    );
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe("FORBIDDEN_ITEMS");
    expect(paramsOf(res)).toEqual({ ids: theirs.versionIds.join(","), count: 1 });
    for (const id of [...mine.versionIds, ...theirs.versionIds])
      expect(row("track_versions", id)?.deleted_at).toBeNull();
  });

  it("answers NOT_FOUND for items the user cannot see or that are already deleted", async () => {
    const songId = newSong("Hidden");
    const a = track(songId, "A", ids.eda ?? "");
    const res = await call(t, batchDelete, { body: { tracks: [a.trackId] } }, guest);
    expect(codeOf(res)).toBe("NOT_FOUND");
    expect(paramsOf(res)).toEqual({ ids: a.trackId, count: 1 });
    expect(codeOf(await call(t, batchDelete, { body: { tracks: ["nope"] } }, admin))).toBe(
      "NOT_FOUND",
    );
  });

  it("deletes own versions for a contributor, with one batchId, SSE and a new mix", async () => {
    const songId = newSong("Own");
    const mine = track(songId, "Mine", ids.petr ?? "", 3);
    const res = await call(
      t,
      batchDelete,
      { body: { versions: mine.versionIds.slice(1) } },
      member,
    );
    expect(res.statusCode).toBe(200);
    const { batchId, count } = res.json<{ batchId: string; count: number }>();
    expect(count).toBe(2);
    for (const id of mine.versionIds.slice(1)) {
      expect(row("track_versions", id)).toMatchObject({ deleted_by: ids.petr });
      const [e] = listEvents(t.db, { action: "version.deleted", targetId: id });
      expect(JSON.parse(e?.details ?? "{}")).toMatchObject({ batchId });
    }
    // The newest remaining version is current again.
    expect(row("tracks", mine.trackId)?.current_version_id).toBe(mine.versionIds[0]);
    expect(published.filter((e) => e.type === "version.deleted")).toHaveLength(2);
    // No automatic mix follows any more (SPEC §27).
    expect(
      t.db.$client.prepare("SELECT count(*) AS n FROM jobs WHERE type = 'audio.mixdown'").get(),
    ).toEqual({ n: 0 });
  });

  it("deletes songs (managers only) and publishes project-scoped SSE", async () => {
    const a = newSong("Song A");
    const b = newSong("Song B");
    expect(codeOf(await call(t, batchDelete, { body: { songs: [a] } }, editor))).toBe(
      "FORBIDDEN_ITEMS",
    );
    expect((await call(t, batchDelete, { body: { songs: [a, b] } }, manager)).statusCode).toBe(200);
    expect(row("songs", a)).toMatchObject({ deleted_by: ids.mara });
    const events = published.filter((e) => e.type === "song.deleted");
    expect(events.map((e) => [e.projectId, e.songId, e.data.songId])).toEqual([
      [ids.project, undefined, a],
      [ids.project, undefined, b],
    ]);
  });

  it("the single song delete records who deleted and publishes SSE too", async () => {
    const s = newSong("Single");
    expect((await call(t, deleteSong, { params: { id: s } }, manager)).statusCode).toBe(200);
    expect(row("songs", s)).toMatchObject({ deleted_by: ids.mara });
    expect(published.map((e) => [e.type, e.data.songId])).toContainEqual(["song.deleted", s]);
  });
});

describe("Trash list and restore (SPEC §26.3)", () => {
  let songId: string;
  let bass: ReturnType<typeof track>;
  let keys: ReturnType<typeof track>;

  beforeAll(async () => {
    songId = newSong("Trashy");
    bass = track(songId, "Bass", ids.petr ?? "", 2);
    keys = track(songId, "Keys", ids.eda ?? "");
    await call(t, batchDelete, { body: { versions: [bass.versionIds[1] ?? ""] } }, member);
    await call(t, batchDelete, { body: { tracks: [keys.trackId] } }, editor);
  });

  it("lists deleted items with who, when, size and what the user may do", async () => {
    const list = await trashOf(member);
    expect(list.retentionDays).toBe(30);
    const v = list.items.find((i) => i.id === bass.versionIds[1]);
    expect(v).toMatchObject({
      kind: "version",
      number: 2,
      song: { id: songId, title: "Trashy", deleted: false },
      track: { id: bass.trackId, name: "Bass", deleted: false },
      deletedBy: { id: ids.petr, displayName: "Petr" },
      bytes: 1100,
      shared: false,
      canRestore: true,
      canPurge: true,
    });
    expect((v?.purgeAt ?? 0) - (v?.deletedAt ?? 0)).toBe(30 * 24 * 3600 * 1000);
    const k = list.items.find((i) => i.id === keys.trackId);
    expect(k).toMatchObject({ kind: "track", bytes: 1100, canRestore: false, canPurge: false });
    expect((await trashOf(manager)).items.find((i) => i.id === keys.trackId)).toMatchObject({
      canRestore: true,
      canPurge: true,
    });
  });

  it("is for users who may delete: viewers and guests are refused", async () => {
    expect(
      codeOf(await call(t, listProjectTrash, { params: { id: ids.project ?? "" } }, guest)),
    ).toBe("NOT_FOUND");
    expect(codeOf(await call(t, listAdminTrash, {}, manager))).toBe("FORBIDDEN");
    const all = TrashListSchema.parse((await call(t, listAdminTrash, {}, admin)).json());
    expect(all.items.some((i: TrashItem) => i.id === keys.trackId)).toBe(true);
  });

  it("restores needs the same right as deleting", async () => {
    expect(codeOf(await call(t, batchRestore, { body: { tracks: [keys.trackId] } }, member))).toBe(
      "FORBIDDEN_ITEMS",
    );
    // Restore of a live item: not in the Trash.
    expect(codeOf(await call(t, batchRestore, { body: { tracks: [bass.trackId] } }, manager))).toBe(
      "NOT_FOUND",
    );
  });

  it("a restored version becomes current again when it is newer", async () => {
    expect(row("tracks", bass.trackId)?.current_version_id).toBe(bass.versionIds[0]);
    const res = await call(
      t,
      batchRestore,
      { body: { versions: [bass.versionIds[1] ?? ""] } },
      member,
    );
    expect(res.statusCode).toBe(200);
    expect(row("track_versions", bass.versionIds[1] ?? "")).toMatchObject({
      deleted_at: null,
      deleted_by: null,
    });
    expect(row("tracks", bass.trackId)?.current_version_id).toBe(bass.versionIds[1]);
    expect(listEvents(t.db, { action: "version.restored" })).toHaveLength(1);
    expect(published.map((e) => e.type)).toContain("version.restored");
  });

  it("a track in a deleted song needs the song restored first, or together", async () => {
    await call(t, batchDelete, { body: { songs: [songId] } }, manager);
    const alone = await call(t, batchRestore, { body: { tracks: [keys.trackId] } }, manager);
    expect(codeOf(alone)).toBe("TRASH_PARENT_DELETED");
    expect(paramsOf(alone)).toEqual({ ids: keys.trackId, count: 1 });
    expect(row("tracks", keys.trackId)?.deleted_at).not.toBeNull();
    const together = await call(
      t,
      batchRestore,
      { body: { songs: [songId], tracks: [keys.trackId] } },
      manager,
    );
    expect(together.statusCode).toBe(200);
    expect(row("songs", songId)?.deleted_at).toBeNull();
    expect(row("tracks", keys.trackId)?.deleted_at).toBeNull();
    const batchIds = new Set(
      [
        ...listEvents(t.db, { action: "song.restored", targetId: songId }),
        ...listEvents(t.db, { action: "track.restored", targetId: keys.trackId }),
      ].map((e) => (JSON.parse(e.details ?? "{}") as { batchId: string }).batchId),
    );
    expect(batchIds.size).toBe(1);
  });
});

describe("purge (SPEC §26.3)", () => {
  it("deletes permanently: rows, variants, usage; comments on the song stay", async () => {
    const songId = newSong("Purge");
    const bass = track(songId, "Bass", ids.petr ?? "", 2);
    const commentId = (
      await call(t, createComment, { params: { id: songId }, body: { body: "Keep me" } }, member)
    ).json<{ comment: { id: string } }>().comment.id;
    const usageBefore = getUsage(t.db, ids.petr ?? "");
    const v2 = bass.versionIds[1] ?? "";
    const assetId = t.db
      .select()
      .from(schema.trackVersions)
      .where(eq(schema.trackVersions.id, v2))
      .get()?.assetId;
    const hashes = t.db
      .select()
      .from(schema.assetVariants)
      .where(eq(schema.assetVariants.assetId, assetId ?? ""))
      .all()
      .map((v) => v.blobHash);
    // Not in the Trash yet.
    expect(codeOf(await call(t, batchPurge, { body: { versions: [v2] } }, member))).toBe(
      "NOT_FOUND",
    );
    await call(t, batchDelete, { body: { versions: [v2] } }, member);
    // Delete does not free anything.
    expect(getUsage(t.db, ids.petr ?? "")).toBe(usageBefore);
    const res = await call(t, batchPurge, { body: { versions: [v2] } }, member);
    expect(res.json()).toMatchObject({ ok: true, count: 1, bytesFreed: 1100 });
    expect(row("track_versions", v2)).toBeUndefined();
    expect(getUsage(t.db, ids.petr ?? "")).toBe(usageBefore - 1100);
    expect(
      t.db
        .select()
        .from(schema.assets)
        .where(eq(schema.assets.id, assetId ?? ""))
        .get(),
    ).toBeUndefined();
    for (const h of hashes) {
      const b = t.db.select().from(schema.blobs).where(eq(schema.blobs.hash, h)).get();
      expect(b?.refCount).toBe(0);
      expect(b?.unreferencedAt).not.toBeNull();
    }
    expect(
      t.db.select().from(schema.comments).where(eq(schema.comments.id, commentId)).get()?.body,
    ).toBe("Keep me");
    const [e] = listEvents(t.db, { action: "version.purged", targetId: v2 });
    expect(e?.actorUserId).toBe(ids.petr);
    // The files go with a blob.gc job after the default 10 min grace, not the daily GC.
    const gc = t.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.type, "blob.gc"))
      .all()
      .find((j) => hashes.every((h) => j.payload.includes(h)));
    expect(gc?.status).toBe("queued");
    expect(JSON.parse(gc?.payload ?? "{}")).toMatchObject({ graceMs: 600_000 });
    expect((gc?.runAfter ?? 0) - Date.now()).toBeGreaterThan(590_000);
    expect(published.map((x) => [x.type, x.projectId])).toContainEqual([
      "trash.changed",
      ids.project,
    ]);
  });

  it("only managers purge songs and others' items", async () => {
    const songId = newSong("Others");
    const keys = track(songId, "Keys", ids.eda ?? "");
    await call(t, batchDelete, { body: { tracks: [keys.trackId] } }, editor);
    expect(codeOf(await call(t, batchPurge, { body: { tracks: [keys.trackId] } }, editor))).toBe(
      "FORBIDDEN_ITEMS",
    );
    await call(t, batchDelete, { body: { songs: [songId] } }, manager);
    expect(codeOf(await call(t, batchPurge, { body: { songs: [songId] } }, editor))).toBe(
      "FORBIDDEN_ITEMS",
    );
    const res = await call(
      t,
      batchPurge,
      { body: { songs: [songId], tracks: [keys.trackId] } },
      manager,
    );
    expect(res.json()).toMatchObject({ count: 2, bytesFreed: 1100 });
    expect(row("songs", songId)).toBeUndefined();
    expect(row("tracks", keys.trackId)).toBeUndefined();
  });

  it("purging a song takes everything in it, but keeps assets another version shares", async () => {
    const songId = newSong("Shared");
    const a = track(songId, "A", ids.petr ?? "");
    const other = newSong("Copy");
    const sharedAsset = t.db
      .select()
      .from(schema.trackVersions)
      .where(eq(schema.trackVersions.id, a.versionIds[0] ?? ""))
      .get()?.assetId;
    // A copy (SPEC §26.6) points at the same asset.
    createTrackWithVersion(t.db, {
      songId: other,
      name: "A copy",
      assetId: sharedAsset ?? "",
      uploadedBy: ids.petr ?? "",
    });
    await call(t, batchDelete, { body: { songs: [songId] } }, manager);
    const listed = (await trashOf(manager)).items.find((i) => i.id === songId);
    expect(listed).toMatchObject({ bytes: 0, shared: true });
    const usage = getUsage(t.db, ids.petr ?? "");
    const res = await call(t, batchPurge, { body: { songs: [songId] } }, manager);
    expect(res.json()).toMatchObject({ count: 1, bytesFreed: 0 });
    expect(row("tracks", a.trackId)).toBeUndefined();
    expect(getUsage(t.db, ids.petr ?? "")).toBe(usage);
    expect(
      t.db
        .select()
        .from(schema.assets)
        .where(eq(schema.assets.id, sharedAsset ?? ""))
        .get(),
    ).toBeDefined();
  });
});
