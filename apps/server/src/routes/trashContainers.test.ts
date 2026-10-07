import { randomBytes } from "node:crypto";
import {
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
  createProject,
  createProjectTextDocument,
  createSongTextDocument,
  deleteDocument,
  deleteProject,
  getProject,
  listAdminTrash,
  listProjectTrash,
  TrashListSchema,
} from "@bandroom/shared";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "../testing/testApp";

/** Deleted projects (admin Trash) and documents (project Trash), SPEC §26.3. */

let t: TestApp;
let admin: string;
let manager: string;
let member: string; // contributor by the instance default
const ids: Record<string, string> = {};

const codeOf = (res: LightMyRequestResponse) =>
  res.statusCode >= 400 ? ApiErrorSchema.parse(res.json()).code : "ok";
const adminTrash = async () =>
  TrashListSchema.parse((await call(t, listAdminTrash, {}, admin)).json()).items;
const projectTrash = async (projectId: string, cookie: string) =>
  TrashListSchema.parse(
    (await call(t, listProjectTrash, { params: { id: projectId } }, cookie)).json(),
  ).items;

function blob(size: number): string {
  const hash = randomBytes(32).toString("hex");
  t.db
    .insert(schema.blobs)
    .values({ hash, sizeBytes: size, storageKey: `x/${hash}`, refCount: 0, createdAt: 0 })
    .run();
  return hash;
}

function audioAsset(uploadedBy: string, size = 1000): string {
  const a = createAsset(t.db, {
    kind: "audio",
    originalFilename: "x.wav",
    sizeBytes: 1,
    originalHash: randomBytes(32).toString("hex"),
    uploadedBy,
  });
  putVariant(t.db, a.id, "opus", blob(size));
  setAssetStatus(t.db, a.id, "ready");
  return a.id;
}

async function newProject(name: string): Promise<string> {
  const id = (await call(t, createProject, { body: { name } }, admin)).json<{
    project: { id: string };
  }>().project.id;
  setProjectGrantRow(t.db, id, ids.mara ?? "", "manager", ids.boss ?? "");
  return id;
}

const projectRow = (id: string) =>
  t.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
const documentRow = (id: string) =>
  t.db.select().from(schema.documents).where(eq(schema.documents.id, id)).get();

beforeAll(async () => {
  t = await createTestApp();
  ids.boss = (await seedUser(t, "boss", "admin")).id;
  ids.mara = (await seedUser(t, "mara", "member")).id;
  ids.petr = (await seedUser(t, "petr", "member")).id;
  admin = await loginAs(t, "boss");
  manager = await loginAs(t, "mara");
  member = await loginAs(t, "petr");
});
afterAll(async () => {
  await t.close();
});

describe("deleted projects in Admin → Trash", () => {
  it("lists a deleted project with who deleted it; only admins restore it", async () => {
    const projectId = await newProject("Old album");
    expect((await call(t, deleteProject, { params: { id: projectId } }, manager)).statusCode).toBe(
      200,
    );
    expect(projectRow(projectId)?.deletedBy).toBe(ids.mara);
    const row = (await adminTrash()).find((i) => i.id === projectId);
    expect(row).toMatchObject({
      kind: "project",
      name: "Old album",
      song: null,
      deletedBy: { id: ids.mara, displayName: "Mara" },
      canRestore: true,
      canPurge: true,
    });
    // The manager may not restore or purge it (only admins see deleted projects).
    expect(codeOf(await call(t, batchRestore, { body: { projects: [projectId] } }, manager))).toBe(
      "FORBIDDEN_ITEMS",
    );
    expect(codeOf(await call(t, batchPurge, { body: { projects: [projectId] } }, member))).toBe(
      "FORBIDDEN_ITEMS",
    );
    // A live project is not in the Trash.
    const live = await newProject("Live");
    expect(codeOf(await call(t, batchRestore, { body: { projects: [live] } }, admin))).toBe(
      "NOT_FOUND",
    );

    const res = await call(t, batchRestore, { body: { projects: [projectId] } }, admin);
    expect(res.json()).toMatchObject({ ok: true, count: 1 });
    expect(projectRow(projectId)).toMatchObject({ deletedAt: null, deletedBy: null });
    expect((await call(t, getProject, { params: { id: projectId } }, manager)).statusCode).toBe(
      200,
    );
    expect(listEvents(t.db, { action: "project.restored", targetId: projectId })).toHaveLength(1);
    expect((await adminTrash()).some((i) => i.id === projectId)).toBe(false);
  });

  it("purges a project with its songs, documents and files", async () => {
    const projectId = await newProject("Purge me");
    const songId = createSongRow(t.db, { projectId, title: "S", createdBy: ids.petr ?? "" }).id;
    createTrackWithVersion(t.db, {
      songId,
      name: "Bass",
      assetId: audioAsset(ids.petr ?? ""),
      uploadedBy: ids.petr ?? "",
    });
    const doc = (
      await call(
        t,
        createProjectTextDocument,
        { params: { id: projectId }, body: { title: "Setlist", kind: "text", text: "1. S" } },
        member,
      )
    ).json<{ document: { id: string } }>().document.id;
    const usage = getUsage(t.db, ids.petr ?? "");
    await call(t, deleteProject, { params: { id: projectId } }, admin);
    const row = (await adminTrash()).find((i) => i.id === projectId);
    expect(row?.bytes).toBeGreaterThanOrEqual(1000);

    const res = await call(t, batchPurge, { body: { projects: [projectId] } }, admin);
    expect(res.json()).toMatchObject({ ok: true, count: 1 });
    expect(projectRow(projectId)).toBeUndefined();
    expect(t.db.select().from(schema.songs).where(eq(schema.songs.id, songId)).get()).toBe(
      undefined,
    );
    expect(documentRow(doc)).toBeUndefined();
    expect(getUsage(t.db, ids.petr ?? "")).toBeLessThan(usage);
    expect(listEvents(t.db, { action: "project.purged", targetId: projectId })).toHaveLength(1);
    expect(
      t.db.select().from(schema.jobs).where(eq(schema.jobs.type, "blob.gc")).all().length,
    ).toBeGreaterThan(0);
  });
});

describe("deleted documents in the project Trash", () => {
  it("lists, restores (creator) and purges (managers) documents", async () => {
    const projectId = await newProject("Docs");
    const mk = async (title: string) =>
      (
        await call(
          t,
          createProjectTextDocument,
          { params: { id: projectId }, body: { title, kind: "markdown", text: "# x" } },
          member,
        )
      ).json<{ document: { id: string } }>().document.id;
    const a = await mk("Lyrics");
    const b = await mk("Chords");
    await call(t, deleteDocument, { params: { id: a } }, member);
    await call(t, deleteDocument, { params: { id: b } }, member);
    expect(documentRow(a)?.deletedBy).toBe(ids.petr);
    const rows = await projectTrash(projectId, member);
    expect(rows.find((i) => i.id === a)).toMatchObject({
      kind: "document",
      name: "Lyrics",
      song: null,
      canRestore: true,
      canPurge: false,
    });
    // The creator restores; purging needs trash.purge (managers).
    expect(codeOf(await call(t, batchRestore, { body: { documents: [a] } }, member))).toBe("ok");
    expect(documentRow(a)).toMatchObject({ deletedAt: null, deletedBy: null });
    expect(listEvents(t.db, { action: "document.restored", targetId: a })).toHaveLength(1);
    expect(codeOf(await call(t, batchPurge, { body: { documents: [b] } }, member))).toBe(
      "FORBIDDEN_ITEMS",
    );
    expect(codeOf(await call(t, batchPurge, { body: { documents: [b] } }, manager))).toBe("ok");
    expect(documentRow(b)).toBeUndefined();
    expect(listEvents(t.db, { action: "document.purged", targetId: b })).toHaveLength(1);
    // Live documents are not in the Trash.
    expect(codeOf(await call(t, batchPurge, { body: { documents: [a] } }, manager))).toBe(
      "NOT_FOUND",
    );
  });

  it("leaves a song's documents to the song while it is in the Trash", async () => {
    const projectId = await newProject("Song docs");
    const songId = createSongRow(t.db, {
      projectId,
      title: "Ballad",
      createdBy: ids.mara ?? "",
    }).id;
    const doc = (
      await call(
        t,
        createSongTextDocument,
        { params: { id: songId }, body: { title: "Words", kind: "text", text: "la" } },
        manager,
      )
    ).json<{ document: { id: string } }>().document.id;
    await call(t, deleteDocument, { params: { id: doc } }, manager);
    expect((await projectTrash(projectId, manager)).find((i) => i.id === doc)?.song).toMatchObject({
      id: songId,
      title: "Ballad",
      deleted: false,
    });
    await call(t, batchDelete, { body: { songs: [songId] } }, manager);
    expect((await projectTrash(projectId, manager)).some((i) => i.id === doc)).toBe(false);
    // Restoring it alone needs the song back first (or in the same call).
    expect(codeOf(await call(t, batchRestore, { body: { documents: [doc] } }, manager))).toBe(
      "TRASH_PARENT_DELETED",
    );
    expect(
      codeOf(await call(t, batchRestore, { body: { songs: [songId], documents: [doc] } }, manager)),
    ).toBe("ok");
    expect(documentRow(doc)?.deletedAt).toBeNull();
  });
});
