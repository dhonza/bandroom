import {
  createAsset,
  createSongRow,
  createTrackWithVersion,
  listEvents,
  putVariant,
  schema,
  setAssetStatus,
  setProjectGrantRow,
} from "@bandroom/server-core";
import {
  convertMarkers,
  createComment,
  createMarker,
  createProject,
  deleteMarker,
  getSongWhatsNew,
  listSongMarkers,
  recordSongVisit,
  restoreMarker,
  updateMarker,
  type Marker,
  type WhatsNew,
} from "@bandroom/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "../testing/testApp";

let t: TestApp;
let admin: string;
let member: string; // contributor (default member role)
let viewer: string;
let songId: string;
let projectId: string;
let bossId: string;

beforeAll(async () => {
  t = await createTestApp();
  const boss = await seedUser(t, "boss", "admin");
  await seedUser(t, "petr", "member");
  const v = await seedUser(t, "vera", "member");
  admin = await loginAs(t, "boss");
  member = await loginAs(t, "petr");
  viewer = await loginAs(t, "vera");
  bossId = boss.id;
  projectId = (await call(t, createProject, { body: { name: "Album" } }, admin)).json<{
    project: { id: string };
  }>().project.id;
  setProjectGrantRow(t.db, projectId, v.id, "viewer", boss.id);
  songId = createSongRow(t.db, { projectId, title: "Song", createdBy: boss.id }).id;
});
afterAll(async () => {
  await t.close();
});

const list = async (cookie = member) =>
  (await call(t, listSongMarkers, { params: { id: songId } }, cookie)).json<{
    markers: Marker[];
    timelineRev: number;
  }>();

const create = async (body: Record<string, unknown>, cookie = member) =>
  call(t, createMarker, { params: { id: songId }, body }, cookie);

describe("markers and sections (SPEC §7.4)", () => {
  it("creates markers and sections, stacks overlaps in lanes and bumps the revision", async () => {
    const rev0 = (await list()).timelineRev;
    const a = await create({
      type: "section",
      name: "Verse 1",
      color: "blue",
      startSec: 10,
      endSec: 30,
    });
    expect(a.statusCode).toBe(200);
    await create({ type: "section", name: "Chorus", color: "red", startSec: 30, endSec: 50 });
    await create({ type: "section", name: "Solo", color: "yellow", startSec: 40, endSec: 60 });
    const m = await create({ type: "marker", name: "Break", color: "pink", startSec: 45 });
    expect(m.json<{ marker: Marker }>().marker).toMatchObject({
      type: "marker",
      endSec: null,
      anchor: "time",
      createdByName: "Petr",
    });
    const { markers, timelineRev } = await list(viewer);
    expect(timelineRev).toBe(rev0 + 4);
    expect(markers.map((x) => [x.name, x.lane])).toEqual([
      ["Verse 1", 0],
      ["Chorus", 0],
      ["Solo", 1],
      ["Break", 0],
    ]);
    // Moving the solo after the chorus frees lane 1.
    const solo = markers.find((x) => x.name === "Solo");
    const moved = await call(
      t,
      updateMarker,
      { params: { id: solo?.id ?? "" }, body: { startSec: 50, endSec: 70 } },
      member,
    );
    expect(moved.json<{ marker: Marker }>().marker.lane).toBe(0);
  });

  it("validates sections and names", async () => {
    expect(
      (await create({ type: "section", name: "X", color: "red", startSec: 5, endSec: 5 }))
        .statusCode,
    ).toBe(400);
    expect((await create({ type: "marker", name: "", color: "red", startSec: 1 })).statusCode).toBe(
      400,
    );
    expect(
      (await create({ type: "marker", name: "x".repeat(61), color: "red", startSec: 1 }))
        .statusCode,
    ).toBe(400);
    const { markers } = await list();
    const verse = markers.find((x) => x.name === "Verse 1");
    const bad = await call(
      t,
      updateMarker,
      { params: { id: verse?.id ?? "" }, body: { endSec: 5 } },
      member,
    );
    expect(bad.statusCode).toBe(400);
  });

  it("lets viewers read only, contributors edit their own, editors anything", async () => {
    expect(
      (await create({ type: "marker", name: "V", color: "red", startSec: 1 }, viewer)).statusCode,
    ).toBe(403);
    const mine = (
      await create({ type: "marker", name: "Admin's", color: "green", startSec: 2 }, admin)
    ).json<{ marker: Marker }>().marker;
    const other = await call(
      t,
      updateMarker,
      { params: { id: mine.id }, body: { name: "Mine now" } },
      member,
    );
    expect(other.statusCode).toBe(403);
    expect((await call(t, deleteMarker, { params: { id: mine.id } }, member)).statusCode).toBe(403);
    const petrs = (await list()).markers.find((x) => x.name === "Break");
    const byAdmin = await call(
      t,
      updateMarker,
      { params: { id: petrs?.id ?? "" }, body: { name: "Big break", color: "orange" } },
      admin,
    );
    expect(byAdmin.json<{ marker: Marker }>().marker).toMatchObject({
      name: "Big break",
      color: "orange",
    });
    expect((await call(t, listSongMarkers, { params: { id: "nope" } }, member)).statusCode).toBe(
      404,
    );
  });

  it("soft-deletes with undo and logs every change", async () => {
    const { markers } = await list();
    const chorus = markers.find((x) => x.name === "Chorus");
    const id = chorus?.id ?? "";
    expect((await call(t, deleteMarker, { params: { id } }, member)).statusCode).toBe(200);
    expect((await list()).markers.some((x) => x.id === id)).toBe(false);
    const restored = await call(t, restoreMarker, { params: { id } }, member);
    expect(restored.json<{ marker: Marker }>().marker.name).toBe("Chorus");
    expect((await list()).markers.some((x) => x.id === id)).toBe(true);
    const actions = listEvents(t.db).map((e) => e.action);
    for (const a of [
      "section.created",
      "marker.created",
      "section.updated",
      "marker.updated",
      "section.deleted",
      "section.restored",
    ]) {
      expect(actions).toContain(a);
    }
  });
});

describe("offline outbox replays (SPEC §13, §18.3)", () => {
  it("creates a marker once per requestId", async () => {
    const requestId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c";
    const body = { type: "marker", name: "Offline", color: "teal", startSec: 3, requestId };
    const a = (await create(body)).json<{ marker: Marker }>().marker;
    const b = (await create(body)).json<{ marker: Marker }>().marker;
    expect(b.id).toBe(a.id);
    expect((await list()).markers.filter((x) => x.name === "Offline")).toHaveLength(1);
  });
});

describe("what's new since the last visit (SPEC §11.3)", () => {
  it("lists others' changes since the previous visit", async () => {
    const first = await call(t, getSongWhatsNew, { params: { id: songId } }, viewer);
    expect(first.json<WhatsNew>()).toEqual({
      since: null,
      versions: [],
      markers: [],
      commentCount: 0,
      firstComment: null,
    });
    await call(t, recordSongVisit, { params: { id: songId } }, viewer);
    await new Promise((r) => setTimeout(r, 5));
    await create({ type: "marker", name: "Fresh", color: "teal", startSec: 70 });
    const res = (
      await call(t, getSongWhatsNew, { params: { id: songId } }, viewer)
    ).json<WhatsNew>();
    expect(res.since).toBeGreaterThan(0);
    expect(res.markers.map((m) => [m.name, m.byName])).toEqual([["Fresh", "Petr"]]);
    // New comments: a count and the earliest one as the jump target (M8).
    const c = await call(
      t,
      createComment,
      { params: { id: songId }, body: { body: "Nice", startSec: 42 } },
      member,
    );
    const commentId = c.json<{ comment: { id: string } }>().comment.id;
    await call(
      t,
      createComment,
      { params: { id: songId }, body: { body: "Reply", parentId: commentId } },
      member,
    );
    const withComments = (
      await call(t, getSongWhatsNew, { params: { id: songId } }, viewer)
    ).json<WhatsNew>();
    expect(withComments.commentCount).toBe(2);
    expect(withComments.firstComment).toEqual({ id: commentId, startSec: 42 });
    // Own changes are not "new" for the author.
    await call(t, recordSongVisit, { params: { id: songId } }, member);
    await new Promise((r) => setTimeout(r, 5));
    await create({ type: "marker", name: "Own", color: "teal", startSec: 71 });
    const own = (
      await call(t, getSongWhatsNew, { params: { id: songId } }, member)
    ).json<WhatsNew>();
    expect(own.markers).toEqual([]);
  });
});

describe("converting markers and sections", () => {
  let song: string;
  type Converted = { markers: Marker[]; deletedIds: string[]; skippedIds: string[] };
  const add = async (body: Record<string, unknown>, cookie = member) =>
    (
      await call(t, createMarker, { params: { id: song }, body: { color: "red", ...body } }, cookie)
    ).json<{ marker: Marker }>().marker;
  const convert = (body: Record<string, unknown>, cookie = member) =>
    call(t, convertMarkers, { params: { id: song }, body }, cookie);
  const items = async () =>
    (await call(t, listSongMarkers, { params: { id: song } }, member)).json<{
      markers: Marker[];
    }>().markers;

  beforeAll(() => {
    song = createSongRow(t.db, { projectId, title: "Convert", createdBy: bossId }).id;
  });

  it("turns markers into sections up to the next marker, the last one to the song end", async () => {
    const intro = await add({ type: "marker", name: "Intro", startSec: 0, note: "soft" });
    const verse = await add({ type: "marker", name: "Verse", color: "blue", startSec: 12 });
    await add({ type: "marker", name: "Other's", startSec: 30 }, admin);
    const outro = await add({ type: "marker", name: "Outro", startSec: 80 });
    // Without ready audio the song has no known end: the last marker stays.
    const noEnd = (await convert({ ids: [outro.id], to: "section" })).json<Converted>();
    expect(noEnd).toMatchObject({ markers: [], deletedIds: [], skippedIds: [outro.id] });
    // A ready 100 s track gives the song its end.
    const asset = createAsset(t.db, {
      kind: "audio",
      originalFilename: "a.wav",
      sizeBytes: 1,
      originalHash: "h",
      uploadedBy: bossId,
    }).id;
    t.db
      .insert(schema.blobs)
      .values({ hash: "b1", sizeBytes: 1, storageKey: "b1", createdAt: 1 })
      .run();
    putVariant(t.db, asset, "opus", "b1", { channels: 2, durationSamples48k: 100 * 48_000 });
    setAssetStatus(t.db, asset, "ready");
    createTrackWithVersion(t.db, { songId: song, name: "A", assetId: asset, uploadedBy: bossId });

    const before = listEvents(t.db, { action: "markers.converted" }).length;
    const requestId = "0192f0c4-0000-7000-8000-00000000c0de";
    const body = { ids: [outro.id, intro.id, verse.id], to: "section", requestId };
    const res = await convert(body);
    expect(res.statusCode).toBe(200);
    const out = res.json<Converted>();
    expect(out.markers.map((m) => [m.type, m.name, m.color, m.note, m.startSec, m.endSec])).toEqual(
      [
        ["section", "Intro", "red", "soft", 0, 12],
        ["section", "Verse", "blue", "", 12, 30], // the next marker is someone else's
        ["section", "Outro", "red", "", 80, 100],
      ],
    );
    expect(out.markers.every((m) => m.createdByName === "Petr")).toBe(true);
    expect(out.deletedIds).toEqual([intro.id, verse.id, outro.id]);
    // A replay returns the first answer and converts nothing again.
    expect((await convert(body)).json<Converted>()).toEqual(out);
    const now = await items();
    expect(now.map((m) => [m.type, m.name])).toEqual([
      ["section", "Intro"],
      ["section", "Verse"],
      ["marker", "Other's"],
      ["section", "Outro"],
    ]);
    const events = listEvents(t.db, { action: "markers.converted" });
    expect(events).toHaveLength(before + 1);
    expect(JSON.parse(events[0]?.details ?? "{}")).toEqual({
      to: "section",
      count: 3,
      sourceIds: out.deletedIds,
      newIds: out.markers.map((m) => m.id),
    });
  });

  it("turns sections back into markers at their start and can be undone", async () => {
    const sections = (await items()).filter((m) => m.type === "section");
    const res = (await convert({ ids: sections.map((m) => m.id), to: "marker" })).json<Converted>();
    expect(res.markers.map((m) => [m.type, m.name, m.startSec, m.endSec])).toEqual([
      ["marker", "Intro", 0, null],
      ["marker", "Verse", 12, null],
      ["marker", "Outro", 80, null],
    ]);
    // Undo with the existing endpoints: restore the sources, delete the new items.
    for (const id of res.deletedIds)
      expect((await call(t, restoreMarker, { params: { id } }, member)).statusCode).toBe(200);
    for (const m of res.markers)
      expect((await call(t, deleteMarker, { params: { id: m.id } }, member)).statusCode).toBe(200);
    expect((await items()).filter((m) => m.type === "section")).toHaveLength(3);
  });

  it("needs the right to act on every converted item", async () => {
    const others = (await items()).find((m) => m.name === "Other's");
    const mine = (await items()).find((m) => m.name === "Intro");
    const ids = [others?.id ?? "", mine?.id ?? ""];
    expect((await convert({ ids, to: "section" })).statusCode).toBe(403);
    expect((await items()).find((m) => m.name === "Intro")?.type).toBe("section");
    expect((await convert({ ids, to: "section" }, viewer)).statusCode).toBe(403);
    // Editors convert anyone's; ids of other songs or deleted items are skipped.
    const res = await convert(
      { ids: [others?.id ?? "", "0192f0c4-0000-7000-8000-000000000001"], to: "section" },
      admin,
    );
    expect(res.json<Converted>()).toMatchObject({
      markers: [{ name: "Other's", startSec: 30, endSec: 100, createdByName: "Boss" }], // "Outro" is a section now
      skippedIds: ["0192f0c4-0000-7000-8000-000000000001"],
    });
  });
});
