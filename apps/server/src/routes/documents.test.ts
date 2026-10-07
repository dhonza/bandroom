import { spawnSync } from "node:child_process";
import { makePdf } from "@bandroom/fixtures";
import {
  createAsset,
  createDocumentWithVersion,
  enqueueDocumentBackfill,
  getAsset,
  listEvents,
  putVariant,
  schema,
  setAssetStatus,
  setProjectGrantRow,
  setSongGrantRow,
  storeFile,
  LocalStorage,
} from "@bandroom/server-core";
import {
  ApiErrorSchema,
  createProject,
  createProjectTextDocument,
  createSong,
  createSongTextDocument,
  deleteDocument,
  deleteDocumentVersion,
  getDocument,
  listDocumentVersions,
  listNotifications,
  listProjectDocuments,
  listSongDocuments,
  restoreDocument,
  restoreDocumentVersion,
  saveDocumentText,
  setCurrentDocumentVersion,
  setSongFollow,
  StreamEventSchema,
  updateDocument,
  updateProject,
  UploadResultSchema,
  type Document,
  type DocumentVersion,
  type Notification,
  type StreamEvent,
} from "@bandroom/shared";
import { eq } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  createTestApp,
  loginAs,
  runQueuedJobs,
  seedUser,
  tusUpload,
  type TestApp,
} from "../testing/testApp";

const HAS_POPPLER =
  spawnSync("pdftoppm", ["-v"]).status === 0 && spawnSync("pdfinfo", ["-v"]).status === 0;
if (!HAS_POPPLER) {
  console.warn("pdftoppm/pdfinfo (poppler-utils) not found: PDF preview tests are skipped");
}

let t: TestApp;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};
let projectId = "";
let songId = "";
let secretSongId = "";
const published: StreamEvent[] = [];

beforeAll(async () => {
  t = await createTestApp();
  const boss = await seedUser(t, "boss", "admin");
  ids.boss = boss.id;
  for (const [name, role] of [
    ["petr", "member"], // contributor (instance default)
    ["jana", "member"], // contributor
    ["eva", "member"], // editor
    ["vik", "member"], // viewer
    ["gus", "guest"], // song grant only (reduced view)
  ] as const) {
    ids[name] = (await seedUser(t, name, role)).id;
  }
  for (const name of Object.keys(ids)) cookies[name] = await loginAs(t, name);
  projectId = (await call(t, createProject, { body: { name: "Album" } }, cookies.boss)).json<{
    project: { id: string };
  }>().project.id;
  songId = (
    await call(t, createSong, { params: { id: projectId }, body: { title: "Song" } }, cookies.boss)
  ).json<{ song: { id: string } }>().song.id;
  secretSongId = (
    await call(
      t,
      createSong,
      { params: { id: projectId }, body: { title: "Secret" } },
      cookies.boss,
    )
  ).json<{ song: { id: string } }>().song.id;
  setProjectGrantRow(t.db, projectId, ids.eva ?? "", "editor", boss.id);
  setProjectGrantRow(t.db, projectId, ids.vik ?? "", "viewer", boss.id);
  setSongGrantRow(t.db, songId, ids.gus ?? "", "viewer", boss.id);
  t.hub.subscribe(
    {
      canSee: () => true,
      send: (frame) => {
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (data) published.push(StreamEventSchema.parse(JSON.parse(data)));
      },
    },
    null,
  );
}, 60_000);
afterAll(async () => {
  await t.close();
});

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed JSON helper
function ok<T>(res: LightMyRequestResponse): T {
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
const codeOf = (res: { statusCode: number; json: () => unknown }) =>
  res.statusCode >= 400 ? ApiErrorSchema.parse(res.json()).code : "OK";

async function upload(who: string, data: Buffer, filename: string, target: unknown) {
  const res = await tusUpload(t, cookies[who] ?? "", data, filename, target);
  return res;
}
async function uploadDoc(who: string, data: Buffer, filename: string, song: string | null) {
  const res = await upload(who, data, filename, { type: "newDocument", projectId, songId: song });
  expect(res.status, res.body).toBe(200);
  const r = UploadResultSchema.parse(JSON.parse(res.body));
  await runQueuedJobs(t);
  return r;
}
const getDoc = async (id: string, who = "petr") =>
  ok<{ document: Document }>(await call(t, getDocument, { params: { id } }, cookies[who])).document;
const versionsOf = async (id: string, who = "petr") =>
  ok<{ versions: DocumentVersion[] }>(
    await call(t, listDocumentVersions, { params: { id } }, cookies[who]),
  ).versions;
const content = (versionId: string, who = "petr", headers: Record<string, string> = {}) =>
  t.app.inject({
    method: "GET",
    url: `${t.basePath}/api/v1/document-versions/${versionId}/content`,
    headers: { cookie: cookies[who] ?? "", ...headers },
  });
const download = (versionId: string, who = "petr") =>
  t.app.inject({
    method: "GET",
    url: `${t.basePath}/api/v1/document-versions/${versionId}/download`,
    headers: { cookie: cookies[who] ?? "" },
  });
const blob = (hash: string, who: string) =>
  t.app.inject({
    method: "GET",
    url: `${t.basePath}/api/v1/blobs/${hash}`,
    headers: { cookie: cookies[who] ?? "" },
  });

describe("documents: upload, ingest, viewers (SPEC §10, §5.7)", () => {
  let mdDocId = "";
  let mdVersionId = "";

  it("uploads Markdown to a song through tus and ingests it as markdown", async () => {
    const before = published.length;
    const r = await uploadDoc(
      "petr",
      Buffer.from("# Lyrics\n\nVerse **one**\n"),
      "Lyrics.md",
      songId,
    );
    mdDocId = r.documentId ?? "";
    mdVersionId = r.documentVersionId ?? "";
    const doc = await getDoc(mdDocId);
    expect(doc).toMatchObject({
      title: "Lyrics",
      kind: "markdown",
      songId,
      versionCount: 1,
      canEdit: true,
      canDelete: true,
      canDownload: true,
      current: { status: "ready", kind: "markdown", number: 1, originalFilename: "Lyrics.md" },
    });
    expect(published.slice(before).some((e) => e.type === "document.changed")).toBe(true);
    expect(listEvents(t.db, { action: "document.created" }).at(-1)).toMatchObject({
      targetId: mdDocId,
      songId,
      actorUserId: ids.petr,
    });
    const list = ok<{ documents: Document[] }>(
      await call(t, listSongDocuments, { params: { id: songId } }, cookies.vik),
    ).documents;
    expect(list.map((d) => d.id)).toEqual([mdDocId]);
    // Viewers see it but may not edit or delete someone else's document.
    expect(list[0]).toMatchObject({ canEdit: false, canDelete: false });
  });

  it("serves the file for viewers as text/plain in a sandbox and logs one view", async () => {
    const res = await content(mdVersionId, "vik");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(String(res.headers["content-security-policy"])).toContain("sandbox");
    expect(res.headers["cache-control"]).toBe("private, no-cache");
    expect(res.body).toContain("Verse **one**");
    await content(mdVersionId, "vik");
    await content(mdVersionId, "vik", { range: "bytes=5-" });
    const views = listEvents(t.db, { action: "document.viewed" }).filter(
      (e) => e.actorUserId === ids.vik,
    );
    expect(views).toHaveLength(1);
  });

  it("detects the kind by content, not by the file name", async () => {
    const pdfNamedTxt = await uploadDoc("petr", makePdf(["One"]), "notes.txt", songId);
    expect((await getDoc(pdfNamedTxt.documentId ?? "")).kind).toBe("pdf");
    const noExt = await uploadDoc("petr", Buffer.from("Am  C  G\nla la la\n"), "chords", songId);
    expect((await getDoc(noExt.documentId ?? "")).kind).toBe("text");
    const latin2 = await uploadDoc(
      "petr",
      Buffer.from([0x50, 0xf8, 0xed, 0x6c, 0x69]),
      "x.txt",
      songId,
    );
    const other = await getDoc(latin2.documentId ?? "");
    expect(other.kind).toBe("other");
    const zip = await uploadDoc("petr", Buffer.from("PK\u0003\u0004rest-of-zip"), "a.docx", songId);
    expect((await getDoc(zip.documentId ?? "")).kind).toBe("other");
    // Binary documents are served as opaque octet streams (never rendered by the browser).
    const res = await content(other.current?.id ?? "");
    expect(res.headers["content-type"]).toBe("application/octet-stream");
  });

  it.skipIf(!HAS_POPPLER)(
    "counts PDF pages and renders a 256 px first-page thumbnail",
    async () => {
      const r = await uploadDoc(
        "petr",
        makePdf(["Page one", "Page two", "Three"]),
        "Chart.pdf",
        songId,
      );
      const doc = await getDoc(r.documentId ?? "");
      expect(doc.current).toMatchObject({ kind: "pdf", pages: 3, status: "ready" });
      const hash = doc.current?.thumbHash ?? "";
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      const img = await blob(hash, "vik");
      expect(img.statusCode).toBe(200);
      expect(img.headers["content-type"]).toBe("image/webp");
      const meta = await sharp(img.rawPayload).metadata();
      expect(Math.max(meta.width, meta.height)).toBe(256);
      expect((await blob(hash, "gus")).statusCode).toBe(200); // gus has a grant on this song
    },
  );

  it("stores an unreadable PDF without a thumbnail (still downloadable)", async () => {
    const r = await uploadDoc("petr", Buffer.from("%PDF-1.4\ngarbage"), "broken.pdf", songId);
    const doc = await getDoc(r.documentId ?? "");
    expect(doc.current).toMatchObject({ kind: "pdf", status: "ready", thumbHash: null });
  });

  it("builds WebP renditions for images (thumbnail and ≤ 2048 px view)", async () => {
    const png = await sharp({
      create: { width: 3000, height: 1500, channels: 3, background: { r: 20, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();
    const r = await uploadDoc("petr", png, "Setlist photo.png", songId);
    const doc = await getDoc(r.documentId ?? "");
    expect(doc.current).toMatchObject({ kind: "image", status: "ready" });
    const view = await sharp(
      (await blob(doc.current?.previewHash ?? "", "petr")).rawPayload,
    ).metadata();
    expect(view).toMatchObject({ width: 2048, height: 1024, format: "webp" });
    const thumb = await sharp(
      (await blob(doc.current?.thumbHash ?? "", "petr")).rawPayload,
    ).metadata();
    expect(thumb).toMatchObject({ width: 256, height: 128 });
  });

  it("refuses uploads from viewers and to invisible songs", async () => {
    const viewer = await upload("vik", Buffer.from("x"), "a.md", {
      type: "newDocument",
      projectId,
      songId,
    });
    expect(viewer.createStatus).toBe(403);
    const hidden = await upload("gus", Buffer.from("x"), "a.md", {
      type: "newDocument",
      projectId,
      songId: secretSongId,
    });
    expect(hidden.createStatus).toBe(404);
    const version = await upload("vik", Buffer.from("x"), "a.md", {
      type: "documentVersion",
      documentId: mdDocId,
    });
    expect(version.createStatus).toBe(403);
  });

  it("adds a version when a file is dropped onto a document", async () => {
    const res = await upload("jana", Buffer.from("# Lyrics v2\n"), "Lyrics.md", {
      type: "documentVersion",
      documentId: mdDocId,
    });
    expect(res.status, res.body).toBe(200);
    await runQueuedJobs(t);
    const doc = await getDoc(mdDocId);
    expect(doc).toMatchObject({ versionCount: 2, current: { number: 2, uploaderName: "Jana" } });
    expect(listEvents(t.db, { action: "document.version_added" }).at(-1)).toMatchObject({
      targetId: mdDocId,
      actorUserId: ids.jana,
    });
  });

  it("edits Markdown as a new version (own: contributor, any: editor) with conflict check", async () => {
    const doc = await getDoc(mdDocId);
    const base = doc.current?.id ?? null;
    const save = (who: string, text: string, baseVersionId: string | null) =>
      call(
        t,
        saveDocumentText,
        { params: { id: mdDocId }, body: { text, baseVersionId } },
        cookies[who],
      );
    expect(codeOf(await save("vik", "x", base))).toBe("FORBIDDEN");
    expect(codeOf(await save("jana", "x", base))).toBe("FORBIDDEN"); // not her document
    const saved = ok<{ document: Document }>(await save("petr", "# Lyrics v3\n", base)).document;
    expect(saved.current).toMatchObject({
      number: 3,
      source: "edit",
      kind: "markdown",
      status: "ready",
    });
    expect(codeOf(await save("eva", "# stale", base))).toBe("EDIT_CONFLICT");
    const byEditor = ok<{ document: Document }>(
      await save("eva", "# Lyrics v4\n", saved.current?.id ?? null),
    ).document;
    expect(byEditor.current?.number).toBe(4);
    expect((await content(byEditor.current?.id ?? "")).body).toBe("# Lyrics v4\n");
  });

  it("refuses editing documents that are not text", async () => {
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const r = await uploadDoc("petr", png, "x.png", songId);
    const res = await call(
      t,
      saveDocumentText,
      {
        params: { id: r.documentId ?? "" },
        body: { text: "hi", baseVersionId: r.documentVersionId ?? null },
      },
      cookies.petr,
    );
    expect(codeOf(res)).toBe("BAD_REQUEST");
  });

  it("sets the current version (editor), deletes and restores versions", async () => {
    const versions = await versionsOf(mdDocId);
    expect(versions.map((v) => v.number)).toEqual([4, 3, 2, 1]);
    const v1 = versions.at(-1)?.id ?? "";
    const setCurrent = (who: string) =>
      call(
        t,
        setCurrentDocumentVersion,
        { params: { id: mdDocId }, body: { versionId: v1 } },
        cookies[who],
      );
    expect(codeOf(await setCurrent("petr"))).toBe("FORBIDDEN");
    expect(ok<{ document: Document }>(await setCurrent("eva")).document.current?.number).toBe(1);

    const v4 = versions[0]?.id ?? "";
    // Jana uploaded v2 only; v4 belongs to Eva.
    expect(codeOf(await call(t, deleteDocumentVersion, { params: { id: v4 } }, cookies.jana))).toBe(
      "FORBIDDEN",
    );
    expect(codeOf(await call(t, deleteDocumentVersion, { params: { id: v1 } }, cookies.petr))).toBe(
      "OK",
    );
    // The newest remaining version becomes current.
    expect((await getDoc(mdDocId)).current?.number).toBe(4);
    expect(
      codeOf(await call(t, restoreDocumentVersion, { params: { id: v1 } }, cookies.petr)),
    ).toBe("OK");
    expect((await versionsOf(mdDocId)).map((v) => v.number)).toEqual([4, 3, 2, 1]);
  });

  it("never deletes the only version", async () => {
    const r = await uploadDoc("petr", Buffer.from("only"), "only.txt", songId);
    const res = await call(
      t,
      deleteDocumentVersion,
      { params: { id: r.documentVersionId ?? "" } },
      cookies.petr,
    );
    expect(codeOf(res)).toBe("BAD_REQUEST");
  });

  it("renames, deletes (soft) and restores documents", async () => {
    const rename = (who: string) =>
      call(t, updateDocument, { params: { id: mdDocId }, body: { title: "Words" } }, cookies[who]);
    expect(codeOf(await rename("jana"))).toBe("FORBIDDEN");
    expect(ok<{ document: Document }>(await rename("petr")).document.title).toBe("Words");
    expect(codeOf(await call(t, deleteDocument, { params: { id: mdDocId } }, cookies.jana))).toBe(
      "FORBIDDEN",
    );
    expect(codeOf(await call(t, deleteDocument, { params: { id: mdDocId } }, cookies.petr))).toBe(
      "OK",
    );
    expect(codeOf(await call(t, getDocument, { params: { id: mdDocId } }, cookies.petr))).toBe(
      "NOT_FOUND",
    );
    const list = ok<{ documents: Document[] }>(
      await call(t, listSongDocuments, { params: { id: songId } }, cookies.petr),
    ).documents;
    expect(list.some((d) => d.id === mdDocId)).toBe(false);
    const restored = ok<{ document: Document }>(
      await call(t, restoreDocument, { params: { id: mdDocId } }, cookies.petr),
    ).document;
    expect(restored.title).toBe("Words");
    expect(listEvents(t.db, { targetId: mdDocId }).map((e) => e.action)).toEqual(
      expect.arrayContaining(["document.updated", "document.deleted", "document.restored"]),
    );
  });
});

describe("documents: download policy (SPEC §3.4, §10)", () => {
  let versionId = "";
  beforeAll(async () => {
    const r = await uploadDoc("petr", Buffer.from("setlist"), "Setlist 2026.txt", null);
    versionId = r.documentVersionId ?? "";
  });

  it("downloads as an attachment with the original name and logs it", async () => {
    const res = await download(versionId, "vik");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain("Setlist%202026.txt");
    expect(res.body).toBe("setlist");
    expect(listEvents(t.db, { action: "document.downloaded" }).at(-1)).toMatchObject({
      actorUserId: ids.vik,
      projectId,
      songId: null,
    });
  });

  it("follows the project's download policy while viewing stays allowed", async () => {
    ok(
      await call(
        t,
        updateProject,
        { params: { id: projectId }, body: { downloadPolicy: "editors" } },
        cookies.boss,
      ),
    );
    expect((await download(versionId, "petr")).statusCode).toBe(403);
    expect((await download(versionId, "eva")).statusCode).toBe(200);
    expect((await content(versionId, "petr")).statusCode).toBe(200);
    const docs = ok<{ documents: Document[] }>(
      await call(t, listProjectDocuments, { params: { id: projectId } }, cookies.petr),
    ).documents;
    expect(docs[0]?.canDownload).toBe(false);
    ok(
      await call(
        t,
        updateProject,
        { params: { id: projectId }, body: { downloadPolicy: "all" } },
        cookies.boss,
      ),
    );
  });
});

describe("documents: project level and the reduced view (SPEC §3.3)", () => {
  let projectDocId = "";
  let projectVersionId = "";

  it("creates Markdown documents in the app at project and song level", async () => {
    const p = ok<{ document: Document }>(
      await call(
        t,
        createProjectTextDocument,
        {
          params: { id: projectId },
          body: { title: "Band rules", kind: "markdown", text: "# Rules" },
        },
        cookies.petr,
      ),
    ).document;
    projectDocId = p.id;
    projectVersionId = p.current?.id ?? "";
    expect(p).toMatchObject({
      songId: null,
      kind: "markdown",
      current: { status: "ready", source: "edit" },
    });
    const s = ok<{ document: Document }>(
      await call(
        t,
        createSongTextDocument,
        { params: { id: secretSongId }, body: { title: "Chords", kind: "text", text: "Am C" } },
        cookies.petr,
      ),
    ).document;
    expect(s).toMatchObject({ songId: secretSongId, kind: "text" });
    expect(
      codeOf(
        await call(
          t,
          createProjectTextDocument,
          { params: { id: projectId }, body: { title: "X", kind: "markdown", text: "" } },
          cookies.vik,
        ),
      ),
    ).toBe("FORBIDDEN");
  });

  it("lists project documents and song documents grouped by visible song", async () => {
    const all = ok<{ documents: Document[]; songs: { songId: string; documents: Document[] }[] }>(
      await call(t, listProjectDocuments, { params: { id: projectId } }, cookies.vik),
    );
    expect(all.documents.some((d) => d.id === projectDocId)).toBe(true);
    expect(all.songs.map((s) => s.songId).sort()).toEqual([songId, secretSongId].sort());
  });

  it("hides project-level documents from users who only have a song grant", async () => {
    const reduced = ok<{ documents: Document[]; songs: { songId: string }[] }>(
      await call(t, listProjectDocuments, { params: { id: projectId } }, cookies.gus),
    );
    expect(reduced.documents).toEqual([]);
    expect(reduced.songs.map((s) => s.songId)).toEqual([songId]);
    expect(codeOf(await call(t, getDocument, { params: { id: projectDocId } }, cookies.gus))).toBe(
      "NOT_FOUND",
    );
    expect((await content(projectVersionId, "gus")).statusCode).toBe(404);
    const hash = t.db
      .select()
      .from(schema.assetVariants)
      .innerJoin(
        schema.documentVersions,
        eq(schema.documentVersions.assetId, schema.assetVariants.assetId),
      )
      .where(eq(schema.documentVersions.id, projectVersionId))
      .get()?.asset_variants.blobHash;
    expect((await blob(hash ?? "", "gus")).statusCode).toBe(404);
    expect((await blob(hash ?? "", "vik")).statusCode).toBe(200);
  });
});

describe("documents: notifications and backfill", () => {
  it("notifies song followers about new documents", async () => {
    ok(
      await call(
        t,
        setSongFollow,
        { params: { id: songId }, body: { following: true } },
        cookies.vik,
      ),
    );
    await uploadDoc("jana", Buffer.from("# Bridge"), "Bridge.md", songId);
    const list = ok<{ notifications: Notification[] }>(
      await call(t, listNotifications, {}, cookies.vik),
    ).notifications;
    expect(list[0]).toMatchObject({
      type: "new_document",
      payload: { documentTitle: "Bridge", songId, actorName: "Jana" },
    });
  });

  it("backfills kind and previews for documents stored without ingest (Samply imports)", async () => {
    const storage = new LocalStorage(path.join(t.dataDir, "blobs"));
    const tmp = path.join(t.dataDir, "import.bin");
    await fs.writeFile(tmp, "# Imported lyrics\n");
    const b = await storeFile(t.db, storage, tmp);
    const asset = createAsset(t.db, {
      kind: "document",
      originalFilename: "lyrics", // Samply names often have no extension
      sizeBytes: b.sizeBytes,
      originalHash: b.hash,
      uploadedBy: ids.boss ?? null,
    });
    putVariant(t.db, asset.id, "original", b.hash, { size: b.sizeBytes });
    setAssetStatus(t.db, asset.id, "ready");
    const { document } = createDocumentWithVersion(t.db, {
      projectId,
      songId,
      title: "lyrics",
      kind: "other",
      assetId: asset.id,
      createdBy: ids.boss ?? "",
      source: "import",
    });
    expect(enqueueDocumentBackfill(t.db)).toBe(1);
    expect(enqueueDocumentBackfill(t.db)).toBe(1); // dedupe: still one queued job
    await runQueuedJobs(t);
    expect(enqueueDocumentBackfill(t.db)).toBe(0);
    expect(getAsset(t.db, asset.id)?.status).toBe("ready");
    expect((await getDoc(document.id)).kind).toBe("text");
  });
});
