import fs from "node:fs";
import path from "node:path";
import { BWF_FILE, FLAC_FILE, generateFixtures, MP3_FILE, TONE_FILE } from "@bandroom/fixtures";
import {
  claimJob,
  executeJob,
  handlerRegistry,
  insertUser,
  hashPassword,
  listEvents,
  LocalStorage,
  makeTempDir,
  schema,
  type JobEvent,
} from "@bandroom/server-core";
import {
  adminUpdateUser,
  cancelImport,
  deleteMySamplyKey,
  deleteProject,
  getMySamplyKey,
  saveMySamplyKey,
  getImportRun,
  samplyConnect,
  scanImport,
  startImport,
  updateImportMapping,
  type ImportMapping,
  type ImportRun,
} from "@bandroom/shared";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFilter } from "../../routes/stream";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "../../testing/testApp";
import { SAMPLY_JOB, samplyImportHandler } from "./job";
import { childrenOf, createFakeSamply, fakeBox } from "./testing/fakeSamply";

const KEY = "samply-test-key-123";
const tmp = makeTempDir();
let t: TestApp;
let cookie: string;
let fake: ReturnType<typeof createFakeSamply>;
/** SSE events the import jobs published (SPEC §25.3). */
const emitted: JobEvent[] = [];

// Tree: "Song One" stack (2 versions) · "Tune" folder (2 equal stems + lyrics) · cover.png.
const v1 = fakeBox("file", "Song One v1.wav", { duration: 10, timeCreated: 1000 });
const v2 = fakeBox("file", "Song One v2.wav", { duration: 10, timeCreated: 2000 });
const songOne = fakeBox("stack", "Song One", { children: childrenOf(v2, v1) });
const bass = fakeBox("file", "Tune - Bass.flac", { duration: 6 });
const drums = fakeBox("file", "Tune - Drums.wav", { duration: 6.1 });
const lyrics = fakeBox("file", "lyrics.txt");
const tune = fakeBox("folder", "Tune", { children: childrenOf(bass, drums, lyrics) });
const cover = fakeBox("file", "cover.png");

async function runSamplyJobs(fetchFn: typeof fetch = fake.fetch): Promise<string[]> {
  const storage = new LocalStorage(path.join(t.dataDir, "blobs"));
  const handlers = handlerRegistry([
    samplyImportHandler({
      appSecret: t.config.appSecret,
      baseUrl: fake.apiBase,
      fetch: fetchFn,
      minIntervalMs: 0,
      backoffMs: 1,
    }),
  ]);
  const out: string[] = [];
  for (;;) {
    const job = claimJob(t.db, "test-server", [SAMPLY_JOB]);
    if (!job) return out;
    out.push(
      await executeJob(
        {
          db: t.db,
          storage,
          workerId: "test-server",
          tmpRoot: t.dataDir,
          emit: (e) => {
            emitted.push(e);
            t.hub.publish(e);
          },
        },
        handlers,
        job,
      ),
    );
  }
}

/** What the admin does in review: group the two equal-length stems, lyrics onto that song. */
function groupTune(mapping: ImportMapping): void {
  const tuneNode = mapping.projects[0]?.nodes.find((n) => n.name === "Tune");
  const [b, d, l] = tuneNode?.children ?? [];
  if (!b || !d || !l) throw new Error("tune nodes");
  Object.assign(b, { action: "songMultitrack", songTitle: "Tune", trackName: "Bass" });
  Object.assign(d, { action: "trackOf", targetId: b.id, trackName: "Drums" });
  l.targetId = b.id;
}

async function getRun(id: string): Promise<ImportRun> {
  const res = await call(t, getImportRun, { params: { id } }, cookie);
  expect(res.statusCode).toBe(200);
  return res.json<{ run: ImportRun }>().run;
}

async function connectAndScan(): Promise<ImportRun> {
  const res = await call(t, samplyConnect, { body: { apiKey: KEY } }, cookie);
  expect(res.statusCode).toBe(200);
  const { run } = res.json<{ run: ImportRun }>();
  const scan = await call(
    t,
    scanImport,
    { params: { id: run.id }, body: { projectIds: ["projA"] } },
    cookie,
  );
  expect(scan.statusCode).toBe(200);
  expect(await runSamplyJobs()).toEqual(["done"]);
  return getRun(run.id);
}

const count = (table: typeof schema.songs | typeof schema.tracks | typeof schema.comments) =>
  t.db.select().from(table).all().length;

beforeAll(async () => {
  await generateFixtures();
  const text = path.join(tmp.dir, "lyrics.txt");
  fs.writeFileSync(text, "La la la\n");
  const png = path.join(tmp.dir, "cover.png");
  fs.writeFileSync(png, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  fake = createFakeSamply({
    apiKey: KEY,
    projects: [
      {
        id: "projA",
        name: "Album A",
        color: "#12b886",
        // Signed-only CDN link (not fetchable); the picture is also listed as the cover.png box.
        artwork: "https://cdn.samply.test/users/u1/files/aaaa-bbbb/cover.png",
        size: 1234,
      },
      { id: "projB", name: "Other", size: 1 },
    ],
    boxes: { projA: [songOne, v2, v1, tune, bass, drums, lyrics, cover] },
    comments: {
      [v2.id]: [
        {
          id: "c1",
          message: "Great take",
          audioTimestamp: 1.5,
          audioTimestampEnd: 3,
          completed: true,
          creator: { email: "Petr@Example.test", displayName: "Petr" },
          reactions: { "👍": { count: 1, users: { u9: { email: "petr@example.test" } } } },
          timeCreated: 5000,
          timeModified: 5000,
        },
        {
          id: "c2",
          message: "Agreed",
          parentid: "c1",
          isReply: true,
          creator: { email: "guest@elsewhere.test", displayName: "Guest Person" },
          timeCreated: 6000,
        },
      ],
      [bass.id]: [{ id: "c3", message: "Tune the E string", audioTimestamp: 2, timeCreated: 7000 }],
    },
    insights: { projA: [{ id: "i1", type: "play", completion: 0.8, timeCreated: 9000 }] },
    files: {
      [v1.id]: { path: TONE_FILE(), contentType: "audio/x-wav" },
      [v2.id]: { path: BWF_FILE(), contentType: "audio/x-wav" },
      [bass.id]: { path: FLAC_FILE(), contentType: "audio/flac" },
      [drums.id]: { path: MP3_FILE(), contentType: "audio/mpeg" },
      [lyrics.id]: { path: text, contentType: "text/plain" },
      [cover.id]: { path: png, contentType: "image/png" },
    },
  });
  t = await createTestApp(
    {},
    { samply: { baseUrl: fake.apiBase, fetch: fake.fetch, backoffMs: 1 } },
  );
  await seedUser(t, "admin", "admin");
  insertUser(t.db, {
    username: "petr",
    displayName: "Petr",
    email: "petr@example.test",
    globalRole: "member",
    passwordHash: await hashPassword("irrelevant-password"),
  });
  cookie = await loginAs(t, "admin");
}, 120_000);

afterAll(async () => {
  await t.close();
  tmp.cleanup();
});

describe("Samply import (SPEC §17)", () => {
  it("rejects a bad key and non-admins", async () => {
    const bad = await call(t, samplyConnect, { body: { apiKey: "wrong-key-000" } }, cookie);
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "SAMPLY_AUTH_FAILED" });
    await seedUser(t, "member1");
    const member = await loginAs(t, "member1");
    const res = await call(t, samplyConnect, { body: { apiKey: KEY } }, member);
    expect(res.statusCode).toBe(403);
  });

  let runId = "";

  it("connects and scans into a proposed mapping with totals", async () => {
    const run = await connectAndScan();
    runId = run.id;
    expect(run.status).toBe("review");
    expect(run.hasKey).toBe(true);
    const p = run.mapping?.projects[0];
    expect(p?.name).toBe("Album A");
    expect(p?.nodes.map((n) => [n.name, n.action])).toEqual([
      ["Song One", "songMix"],
      ["Tune", "container"],
      ["cover", "skip"],
    ]);
    expect(p?.nodes[2]?.isArtwork).toBe(true);
    // Nothing is grouped automatically: the two stems start as separate songs.
    expect(run.totals).toMatchObject({
      songs: 3,
      tracks: 3,
      versions: 4,
      documents: 1,
      comments: 3,
    });
    expect(run.totals?.bytes).toBeGreaterThan(fs.statSync(BWF_FILE()).size);
    // The API key is sealed at rest.
    const row = t.db.select().from(schema.importRuns).where(eq(schema.importRuns.id, run.id)).get();
    expect(row?.secretEnc).toBeTruthy();
    expect(row?.secretEnc).not.toContain(KEY);
  });

  it("dry-runs without writing anything and stays in review", async () => {
    const before = count(schema.songs);
    const res = await call(
      t,
      startImport,
      { params: { id: runId }, body: { dryRun: true } },
      cookie,
    );
    expect(res.statusCode).toBe(200);
    expect(await runSamplyJobs()).toEqual(["done"]);
    const run = await getRun(runId);
    expect(run.status).toBe("review");
    expect(run.report?.dryRun).toBe(true);
    expect(run.report?.counts).toMatchObject({
      "project.planned": 1,
      "song.planned": 3,
      "track.planned": 3,
      "version.planned": 4,
      "document.planned": 1,
      "comment.planned": 3,
    });
    expect(run.report?.unmatchedAuthors.map((a) => a.name).sort()).toEqual([
      "Guest Person",
      "Samply user",
    ]);
    expect(count(schema.songs)).toBe(before);
  });

  it("rejects an invalid reviewed mapping", async () => {
    const run = await getRun(runId);
    const mapping = structuredClone(run.mapping);
    const node = mapping?.projects[0]?.nodes[2]; // cover.png (project picture)
    if (!mapping || !node) throw new Error("mapping");
    node.action = "songMix";
    const res = await call(
      t,
      updateImportMapping,
      { params: { id: runId }, body: { mapping } },
      cookie,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("imports projects, songs, versions, documents, comments and insights", async () => {
    const run0 = await getRun(runId);
    const mapping = structuredClone(run0.mapping);
    if (!mapping) throw new Error("mapping");
    mapping.includeInsights = true;
    groupTune(mapping);
    const saved = await call(
      t,
      updateImportMapping,
      { params: { id: runId }, body: { mapping } },
      cookie,
    );
    expect(saved.statusCode).toBe(200);
    // Scanning and editing the mapping are logged (review M15).
    const logged = (action: "import.scanned" | "import.mapping_changed") =>
      listEvents(t.db, { action }).filter((e) => e.targetId === runId).length;
    expect(logged("import.scanned")).toBe(1);
    expect(logged("import.mapping_changed")).toBe(1);
    const res = await call(
      t,
      startImport,
      { params: { id: runId }, body: { dryRun: false } },
      cookie,
    );
    expect(res.statusCode).toBe(200);
    expect(await runSamplyJobs()).toEqual(["done"]);
    const run = await getRun(runId);
    expect(run.status).toBe("done");
    expect(run.hasKey).toBe(false);
    expect(run.report?.counts).toMatchObject({
      "project.imported": 1,
      "song.imported": 2,
      "track.imported": 3,
      "version.imported": 4,
      "document.imported": 1,
      "comment.imported": 3,
    });

    const db = t.db;
    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.name, "Album A"))
      .get();
    expect(project?.color).toBe("teal");
    expect(project?.imageAssetId).toBeTruthy();
    const songs = db
      .select()
      .from(schema.songs)
      .where(eq(schema.songs.projectId, project?.id ?? ""))
      .all();
    expect(songs.map((s) => s.title).sort()).toEqual(["Song One", "Tune"]);

    const songOneRow = songs.find((s) => s.title === "Song One");
    const mixTrack = db
      .select()
      .from(schema.tracks)
      .where(eq(schema.tracks.songId, songOneRow?.id ?? ""))
      .get();
    expect(mixTrack).toMatchObject({ name: "Mix", role: "mix" });
    const versions = db
      .select()
      .from(schema.trackVersions)
      .where(eq(schema.trackVersions.trackId, mixTrack?.id ?? ""))
      .orderBy(schema.trackVersions.number)
      .all();
    expect(versions.map((v) => [v.number, v.label, v.source])).toEqual([
      [1, "Song One v1", "import"],
      [2, "Song One v2", "import"],
    ]);
    expect(mixTrack?.currentVersionId).toBe(versions[1]?.id);

    const tuneRow = songs.find((s) => s.title === "Tune");
    const stems = db
      .select()
      .from(schema.tracks)
      .where(eq(schema.tracks.songId, tuneRow?.id ?? ""))
      .all();
    expect(stems.map((s) => [s.name, s.role]).sort()).toEqual([
      ["Bass", "track"],
      ["Drums", "track"],
    ]);

    // Originals are stored byte-exact and ingest jobs are queued.
    const bwfSize = fs.statSync(BWF_FILE()).size;
    const asset = db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.id, versions[1]?.assetId ?? ""))
      .get();
    expect(asset?.sizeBytes).toBe(bwfSize);
    const ingests = db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.type, "audio.ingest"), eq(schema.jobs.status, "queued")))
      .all();
    expect(ingests).toHaveLength(4);
    expect(ingests.every((j) => j.priority < 0)).toBe(true);

    const docs = db.select().from(schema.documents).where(isNull(schema.documents.deletedAt)).all();
    // The project picture is the project image, not a document.
    expect(docs.map((d) => [d.title, d.kind, d.songId === tuneRow?.id])).toEqual([
      ["lyrics", "text", true],
    ]);
    const picture = db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.id, project?.imageAssetId ?? ""))
      .get();
    expect(picture).toMatchObject({ kind: "image", originalFilename: "cover.png" });

    const comments = db.select().from(schema.comments).all();
    const c1 = comments.find((c) => c.body === "Great take");
    const c2 = comments.find((c) => c.body === "Agreed");
    const c3 = comments.find((c) => c.body === "Tune the E string");
    const petr = db.select().from(schema.users).where(eq(schema.users.username, "petr")).get();
    expect(c1).toMatchObject({
      authorUserId: petr?.id,
      startSec: 1.5,
      endSec: 3,
      trackId: null,
      source: "import",
    });
    expect(c1?.resolvedAt).toBe(5000);
    expect(JSON.parse(c1?.context ?? "{}")).toEqual({
      trackVersions: { [mixTrack?.id ?? ""]: versions[1]?.id },
    });
    expect(c2).toMatchObject({
      parentId: c1?.id,
      authorUserId: null,
      importedAuthorName: "Guest Person",
    });
    expect(c3?.trackId).toBe(stems.find((s) => s.name === "Bass")?.id);
    const reactions = db.select().from(schema.commentReactions).all();
    expect(reactions).toMatchObject([{ commentId: c1?.id, userId: petr?.id, emoji: "👍" }]);

    const events = db
      .select()
      .from(schema.events)
      .all()
      .map((e) => e.action);
    expect(events).toContain("import.finished");
    expect(events).toContain("import.insight");
  });

  it("publishes project-scoped SSE events that members see (SPEC §25.3)", async () => {
    const songEvents = emitted.filter((e) => e.type === "song.created");
    const versionEvents = emitted.filter((e) => e.type === "version.created");
    expect(songEvents).toHaveLength(2);
    expect(versionEvents).toHaveLength(4);
    expect(emitted.some((e) => e.type === "project.updated" && e.projectId)).toBe(true);
    for (const e of [...songEvents, ...versionEvents]) {
      expect(e.projectId).toBeTruthy();
      expect(e.songId).toBeTruthy();
    }
    const member = await seedUser(t, "sse-member", "member");
    const guest = await seedUser(t, "sse-guest", "guest");
    const memberSees = makeFilter(t, member);
    const guestSees = makeFilter(t, guest);
    expect(songEvents.every((e) => memberSees({ ...e, data: e.data }))).toBe(true);
    expect(versionEvents.every((e) => memberSees({ ...e, data: e.data }))).toBe(true);
    expect(songEvents.some((e) => guestSees({ ...e, data: e.data }))).toBe(false);
  });
  it("re-runs idempotently and imports only new items", async () => {
    const songsBefore = count(schema.songs);
    const commentsBefore = count(schema.comments);
    // A new version appears in Samply.
    const v3 = fakeBox("file", "Song One v3.wav", { duration: 10, timeCreated: 3000 });
    fake.state.boxes.projA?.push(v3);
    songOne.children.push({ id: v3.id, name: v3.name });
    fake.state.files[v3.id] = { path: TONE_FILE(), contentType: "audio/x-wav" };

    const run = await connectAndScan();
    expect(run.mapping?.projects[0]?.existingProjectId).toBeTruthy();
    // The earlier grouping is proposed again, not the defaults.
    const tuneKids = run.mapping?.projects[0]?.nodes.find((n) => n.name === "Tune")?.children ?? [];
    expect(tuneKids.map((n) => [n.name, n.action, n.trackName])).toEqual([
      ["Tune - Bass", "songMultitrack", "Bass"],
      ["Tune - Drums", "trackOf", "Drums"],
      ["lyrics", "document", "lyrics"],
    ]);
    expect(tuneKids[2]?.targetId).toBe(bass.id);
    expect(run.totals).toMatchObject({ versions: 1, alreadyImported: 5 });
    const res = await call(
      t,
      startImport,
      { params: { id: run.id }, body: { dryRun: false } },
      cookie,
    );
    expect(res.statusCode).toBe(200);
    expect(await runSamplyJobs()).toEqual(["done"]);
    const done = await getRun(run.id);
    expect(done.report?.counts).toMatchObject({
      "project.existing": 1,
      "song.existing": 2,
      "track.existing": 3,
      "version.existing": 4,
      "version.imported": 1,
      "comment.existing": 3,
    });
    expect(count(schema.songs)).toBe(songsBefore);
    expect(count(schema.comments)).toBe(commentsBefore);
    const v3Row = t.db
      .select()
      .from(schema.trackVersions)
      .where(eq(schema.trackVersions.label, "Song One v3"))
      .get();
    expect(v3Row?.number).toBe(3);
  });

  it("re-imports everything after the imported project was deleted", async () => {
    const old = t.db
      .select()
      .from(schema.projects)
      .where(and(eq(schema.projects.name, "Album A"), isNull(schema.projects.deletedAt)))
      .get();
    const del = await call(t, deleteProject, { params: { id: old?.id ?? "" } }, cookie);
    expect(del.statusCode).toBe(200);

    const run = await connectAndScan();
    const p = run.mapping?.projects[0];
    expect(p?.existingProjectId).toBeNull();
    expect(run.totals).toMatchObject({ versions: 5, alreadyImported: 0 });
    let versionsFlagged = 0;
    for (const n of p?.nodes ?? []) {
      for (const v of [...n.versions, ...n.children.flatMap((c) => c.versions)])
        if (v.imported) versionsFlagged++;
    }
    expect(versionsFlagged).toBe(0);

    const res = await call(
      t,
      startImport,
      { params: { id: run.id }, body: { dryRun: false } },
      cookie,
    );
    expect(res.statusCode).toBe(200);
    expect(await runSamplyJobs()).toEqual(["done"]);
    const done = await getRun(run.id);
    expect(done.report?.counts).toMatchObject({
      "project.imported": 1,
      "version.imported": 5,
      "comment.imported": 3,
    });
    const fresh = t.db
      .select()
      .from(schema.projects)
      .where(and(eq(schema.projects.name, "Album A"), isNull(schema.projects.deletedAt)))
      .get();
    expect(fresh?.id).not.toBe(old?.id);
    const songs = t.db
      .select()
      .from(schema.songs)
      .where(eq(schema.songs.projectId, fresh?.id ?? ""))
      .all();
    // No grouping was restored from the deleted project, so every audio item is its own song.
    expect(songs.map((s) => s.title).sort()).toEqual(["Song One", "Tune - Bass", "Tune - Drums"]);
  });

  it("reports what a failed attempt imported as imported when the job is retried", async () => {
    const old = t.db
      .select()
      .from(schema.projects)
      .where(and(eq(schema.projects.name, "Album A"), isNull(schema.projects.deletedAt)))
      .get();
    await call(t, deleteProject, { params: { id: old?.id ?? "" } }, cookie);
    const run = await connectAndScan();
    const mapping = run.mapping;
    if (!mapping) throw new Error("mapping");
    groupTune(mapping);
    await call(t, updateImportMapping, { params: { id: run.id }, body: { mapping } }, cookie);
    await call(t, startImport, { params: { id: run.id }, body: { dryRun: false } }, cookie);

    // The first attempt fails after the versions and documents (a comment list is not found),
    // like a run whose attempt failed on "database is locked" (e2e flake, 2026-10-06).
    let failed = false;
    const failingOnce = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!failed && url.endsWith("/comments")) {
        failed = true;
        return Promise.resolve(new Response("{}", { status: 404 }));
      }
      return fake.fetch(input, init);
    }) as typeof fetch;
    expect(await runSamplyJobs(failingOnce)).toEqual(["queued"]);
    t.db.update(schema.jobs).set({ runAfter: 0 }).where(eq(schema.jobs.status, "queued")).run();
    expect(await runSamplyJobs()).toEqual(["done"]);

    const done = await getRun(run.id);
    expect(done.report?.counts).toEqual({
      "project.imported": 1,
      "song.imported": 2,
      "track.imported": 3,
      "version.imported": 5,
      "document.imported": 1,
      "comment.imported": 3,
    });
  });

  it("cancels a run and forgets the key", async () => {
    const res = await call(t, samplyConnect, { body: { apiKey: KEY } }, cookie);
    const { run } = res.json<{ run: ImportRun }>();
    await call(t, scanImport, { params: { id: run.id }, body: { projectIds: ["projA"] } }, cookie);
    const cancel = await call(t, cancelImport, { params: { id: run.id } }, cookie);
    expect(cancel.statusCode).toBe(200);
    expect(await runSamplyJobs()).toEqual([]);
    const after = await getRun(run.id);
    expect(after).toMatchObject({ status: "cancelled", hasKey: false });
    const scan = await call(
      t,
      scanImport,
      { params: { id: run.id }, body: { projectIds: ["projA"] } },
      cookie,
    );
    expect(scan.json()).toMatchObject({ code: "IMPORT_STATE" });
  });
});

describe("Saved Samply key per admin (SPEC §25.11)", () => {
  it("saves, shows only the last four characters, connects with it and forgets it", async () => {
    const empty = await call(t, getMySamplyKey, {}, cookie);
    expect(empty.json()).toEqual({ saved: false, last4: null, updatedAt: null });
    const missing = await call(t, samplyConnect, { body: { useSavedKey: true } }, cookie);
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ code: "SAMPLY_KEY_NOT_SAVED" });

    const put = await call(t, saveMySamplyKey, { body: { apiKey: KEY } }, cookie);
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ saved: true, last4: "-123" });
    const got = await call(t, getMySamplyKey, {}, cookie);
    expect(got.body).not.toContain(KEY);
    expect(got.json()).toMatchObject({ saved: true, last4: "-123" });
    const stored = t.db.select().from(schema.userSecrets).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.secretEnc).not.toContain(KEY);

    const res = await call(t, samplyConnect, { body: { useSavedKey: true } }, cookie);
    expect(res.statusCode).toBe(200);
    const { run } = res.json<{ run: ImportRun }>();
    expect(run.hasKey).toBe(true);
    // The run keeps its own sealed copy: forgetting the saved key does not break the run.
    const del = await call(t, deleteMySamplyKey, {}, cookie);
    expect(del.json()).toEqual({ saved: false, last4: null, updatedAt: null });
    const scan = await call(
      t,
      scanImport,
      { params: { id: run.id }, body: { projectIds: ["projA"] } },
      cookie,
    );
    expect(scan.statusCode).toBe(200);
    await call(t, cancelImport, { params: { id: run.id } }, cookie);
    expect(await runSamplyJobs()).toEqual([]);

    const saved = listEvents(t.db, { action: "secret.saved" });
    const deleted = listEvents(t.db, { action: "secret.deleted" });
    expect(saved).toHaveLength(1);
    expect(deleted).toHaveLength(1);
    for (const e of [...saved, ...deleted]) expect(e.details ?? "").not.toContain(KEY);
    // Deleting again is a no-op without a second event.
    await call(t, deleteMySamplyKey, {}, cookie);
    expect(listEvents(t.db, { action: "secret.deleted" })).toHaveLength(1);
  });

  it("reports a saved key that Samply rejects", async () => {
    await call(t, saveMySamplyKey, { body: { apiKey: "revoked-key-0000" } }, cookie);
    const res = await call(t, samplyConnect, { body: { useSavedKey: true } }, cookie);
    expect(res.json()).toMatchObject({ code: "SAMPLY_AUTH_FAILED" });
    await call(t, deleteMySamplyKey, {}, cookie);
  });

  it("is per admin and admin-only, and is dropped when the admin is demoted", async () => {
    const second = await seedUser(t, "admin2", "admin");
    const other = await loginAs(t, "admin2");
    await call(t, saveMySamplyKey, { body: { apiKey: KEY } }, cookie);
    expect((await call(t, getMySamplyKey, {}, other)).json()).toMatchObject({ saved: false });
    const otherConnect = await call(t, samplyConnect, { body: { useSavedKey: true } }, other);
    expect(otherConnect.json()).toMatchObject({ code: "SAMPLY_KEY_NOT_SAVED" });

    await call(t, saveMySamplyKey, { body: { apiKey: KEY } }, other);
    const demote = await call(
      t,
      adminUpdateUser,
      { params: { id: second.id }, body: { globalRole: "member" } },
      cookie,
    );
    expect(demote.statusCode).toBe(200);
    const rows = t.db.select().from(schema.userSecrets).all();
    expect(rows.map((r) => r.userId)).not.toContain(second.id);
    const member = await loginAs(t, "admin2");
    for (const contract of [getMySamplyKey, deleteMySamplyKey]) {
      expect((await call(t, contract, {}, member)).statusCode).toBe(403);
    }
    const put = await call(t, saveMySamplyKey, { body: { apiKey: KEY } }, member);
    expect(put.statusCode).toBe(403);
    await call(t, deleteMySamplyKey, {}, cookie);
  });
});
