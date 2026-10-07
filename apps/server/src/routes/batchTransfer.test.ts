import { randomBytes } from "node:crypto";
import {
  createAsset,
  createSongRow,
  createTrackWithVersion,
  getUsage,
  listEvents,
  putVariant,
  schema,
  setAssetProbe,
  setAssetStatus,
  setProjectGrantRow,
  setSongGrantRow,
  type Probe,
} from "@bandroom/server-core";
import {
  ApiErrorSchema,
  batchCopySongs,
  batchCopyTracks,
  batchDelete,
  batchMakeMultitrack,
  batchMoveSongs,
  batchMultitrackPreview,
  batchPurge,
  batchRemoveLossless,
  BatchTransferResultSchema,
  createProject,
  MultitrackPreviewSchema,
  uuidv7,
  type StreamEvent,
} from "@bandroom/shared";
import { and, eq, isNull } from "drizzle-orm";
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
const resultOf = (res: LightMyRequestResponse) => {
  expect(res.statusCode, res.body).toBe(200);
  return BatchTransferResultSchema.parse(res.json());
};

/** Stores a fake blob of `size` bytes (no file). */
function blob(size: number): string {
  const hash = randomBytes(32).toString("hex");
  t.db
    .insert(schema.blobs)
    .values({ hash, sizeBytes: size, storageKey: `x/${hash}`, refCount: 0, createdAt: 0 })
    .run();
  return hash;
}

const probe = (durationSec: number): Probe => ({
  container: "wav",
  codec: "pcm_s24le",
  lossless: true,
  sampleRate: 48_000,
  channels: 2,
  sampleFormat: "s32",
  bitDepth: 24,
  isFloat: false,
  durationSamples: Math.round(durationSec * 48_000),
  durationSec,
  tags: {},
  timeReference: null,
});

/** A ready audio asset with flac (1000 B) and opus (100 B) variants. */
function asset(uploadedBy: string, durationSec = 180): string {
  const a = createAsset(t.db, {
    kind: "audio",
    originalFilename: "x.wav",
    sizeBytes: 1,
    originalHash: randomBytes(32).toString("hex"),
    uploadedBy,
  });
  putVariant(t.db, a.id, "flac", blob(1000));
  putVariant(t.db, a.id, "opus", blob(100));
  setAssetProbe(t.db, a.id, probe(durationSec));
  setAssetStatus(t.db, a.id, "ready");
  return a.id;
}

function track(
  songId: string,
  name: string,
  by: string,
  opts: { offset?: number; durationSec?: number } = {},
) {
  const created = createTrackWithVersion(t.db, {
    songId,
    name,
    assetId: asset(by, opts.durationSec),
    uploadedBy: by,
  });
  if (opts.offset)
    t.db
      .update(schema.trackVersions)
      .set({ offsetSamples: opts.offset })
      .where(eq(schema.trackVersions.id, created.version.id))
      .run();
  return { trackId: created.track.id, versionId: created.version.id };
}

const newProject = async (name: string) => {
  const id = (await call(t, createProject, { body: { name } }, admin)).json<{
    project: { id: string };
  }>().project.id;
  setProjectGrantRow(t.db, id, ids.mara ?? "", "manager", ids.boss ?? "");
  setProjectGrantRow(t.db, id, ids.eda ?? "", "editor", ids.boss ?? "");
  return id;
};

const newSong = (title: string, projectId = ids.project ?? "") =>
  createSongRow(t.db, { projectId, title, createdBy: ids.boss ?? "" }).id;

const songRow = (id: string) =>
  t.db.select().from(schema.songs).where(eq(schema.songs.id, id)).get();
const trackRow = (id: string) =>
  t.db.select().from(schema.tracks).where(eq(schema.tracks.id, id)).get();
const versionRow = (id: string) =>
  t.db.select().from(schema.trackVersions).where(eq(schema.trackVersions.id, id)).get();
const liveTracks = (songId: string) =>
  t.db
    .select()
    .from(schema.tracks)
    .where(and(eq(schema.tracks.songId, songId), isNull(schema.tracks.deletedAt)))
    .orderBy(schema.tracks.sortOrder)
    .all();

function comment(songId: string, trackId: string | null, body: string, startSec: number | null) {
  const id = uuidv7();
  t.db
    .insert(schema.comments)
    .values({
      id,
      songId,
      trackId,
      authorUserId: ids.petr ?? null,
      body,
      startSec,
      createdAt: 1000,
    })
    .run();
  return id;
}

function reply(parent: string, songId: string, body: string) {
  const id = uuidv7();
  t.db
    .insert(schema.comments)
    .values({ id, songId, parentId: parent, authorUserId: ids.mara ?? null, body, createdAt: 2000 })
    .run();
  t.db
    .insert(schema.commentReactions)
    .values({ id: uuidv7(), commentId: id, userId: ids.petr ?? null, emoji: "👍", createdAt: 3000 })
    .run();
  return id;
}

function marker(songId: string, name: string, startSec: number, musical = false) {
  t.db
    .insert(schema.markers)
    .values({
      id: uuidv7(),
      songId,
      type: "marker",
      name,
      color: "blue",
      note: "",
      startSec,
      anchor: musical ? "musical" : "time",
      startBeat: musical ? 8 : null,
      createdBy: ids.boss ?? null,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
}

function tempo(songId: string, bar1OffsetSec = 0) {
  const revisionId = uuidv7();
  const data = JSON.stringify({
    segments: [{ startBeat: 0, bpm: 120, meter: { num: 4, den: 4 }, barIndex: 0 }],
  });
  t.db
    .insert(schema.tempoMapRevisions)
    .values({ id: revisionId, songId, source: "manual", data, bar1OffsetSec, createdAt: 1 })
    .run();
  t.db
    .insert(schema.tempoMaps)
    .values({ songId, source: "manual", data, bar1OffsetSec, revisionId, updatedAt: 1 })
    .run();
}

const markersOf = (songId: string) =>
  t.db
    .select()
    .from(schema.markers)
    .where(eq(schema.markers.songId, songId))
    .orderBy(schema.markers.startSec)
    .all();
const commentsOf = (songId: string) =>
  t.db.select().from(schema.comments).where(eq(schema.comments.songId, songId)).all();
const eventsOf = (batchId: string) =>
  t.db
    .select()
    .from(schema.events)
    .all()
    .filter((e) => e.details?.includes(batchId))
    .map((e) => e.action)
    .sort();
/** No automatic mix any more (SPEC §27): nothing schedules `audio.mixdown`. */
const mixdownQueued = (songId: string) =>
  t.db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.dedupeKey, `mixdown:${songId}`))
    .all().length > 0;

beforeAll(async () => {
  t = await createTestApp();
  const boss = await seedUser(t, "boss", "admin");
  const mara = await seedUser(t, "mara", "member");
  const eda = await seedUser(t, "eda", "member");
  const petr = await seedUser(t, "petr", "member");
  const host = await seedUser(t, "host", "guest");
  ids.boss = boss.id;
  ids.mara = mara.id;
  ids.eda = eda.id;
  ids.petr = petr.id;
  ids.host = host.id;
  admin = await loginAs(t, "boss");
  manager = await loginAs(t, "mara");
  editor = await loginAs(t, "eda");
  member = await loginAs(t, "petr");
  guest = await loginAs(t, "host");
  ids.project = await newProject("Album");
  ids.other = await newProject("Live");
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

describe("make multitrack song (SPEC §26.5)", () => {
  it("previews tracks, the suggested name, emptied songs and differing lengths", async () => {
    const a = newSong("Night Train - band");
    const b = newSong("Night Train - vocals");
    track(a, "Drums", ids.petr ?? "", { durationSec: 200 });
    track(a, "Bass", ids.petr ?? "", { durationSec: 200 });
    const vox = track(b, "Vox", ids.petr ?? "", { durationSec: 30 });
    const res = await call(
      t,
      batchMultitrackPreview,
      { body: { songs: [a], tracks: [vox.trackId] } },
      manager,
    );
    const p = MultitrackPreviewSchema.parse(res.json());
    // B brings its only track: it is named after its song (SPEC §26.5, M21).
    expect(p.tracks.map((x) => x.name)).toEqual(["Drums", "Bass", "Night Train - vocals"]);
    expect(p.tracks.map((x) => x.durationSec)).toEqual([200, 200, 30]);
    expect(p.songs).toEqual([
      { id: a, title: "Night Train - band", emptied: true },
      { id: b, title: "Night Train - vocals", emptied: true },
    ]);
    expect(p.suggestedName).toBe("Night Train");
    expect(p.lengthsDiffer).toBe(true);
    // Viewers may preview what they see; others get NOT_FOUND.
    expect(codeOf(await call(t, batchMultitrackPreview, { body: { songs: [a] } }, guest))).toBe(
      "NOT_FOUND",
    );
  });

  it("moves the tracks with offsets, comments, markers and tempo; trashes emptied songs", async () => {
    const a = newSong("Blue A");
    const b = newSong("Blue B");
    // Song A: two tracks, the bass 1 s later. Song B: one track starting at 2 s.
    const drums = track(a, "Drums", ids.petr ?? "");
    const bass = track(a, "Bass", ids.petr ?? "", { offset: 48_000 });
    const keys = track(b, "Keys", ids.mara ?? "", { offset: 96_000 });
    const onDrums = comment(a, drums.trackId, "Drums late", 10);
    const r1 = reply(onDrums, a, "Agreed");
    const songWide = comment(a, null, "Great take", 3);
    const onKeys = comment(b, keys.trackId, "Keys chord", 5);
    marker(a, "Verse", 4, true);
    marker(b, "Solo", 5);
    tempo(a, 0.5);
    tempo(b, 1);
    const usage = getUsage(t.db, ids.petr ?? "");

    const res = await call(
      t,
      batchMakeMultitrack,
      { body: { songs: [a, b], name: "Blue", targetProjectId: ids.project ?? "" } },
      manager,
    );
    const out = resultOf(res);
    expect(out.projectId).toBe(ids.project);
    const songId = out.songIds[0] ?? "";
    expect(songRow(songId)?.title).toBe("Blue");
    // All three tracks moved (same ids), in selection order.
    expect(liveTracks(songId).map((x) => x.id)).toEqual([
      drums.trackId,
      bass.trackId,
      keys.trackId,
    ]);
    // A keeps its relative offsets; B starts at 0.
    expect(versionRow(drums.versionId)?.offsetSamples).toBe(0);
    expect(versionRow(bass.versionId)?.offsetSamples).toBe(48_000);
    expect(versionRow(keys.versionId)?.offsetSamples).toBe(0);
    // Comments on the tracks (with replies) and the song-wide one of the emptied A move along;
    // B's keys comment moves 2 s earlier with its track.
    const moved = commentsOf(songId);
    expect(moved.map((c) => c.id).sort()).toEqual([onDrums, r1, songWide, onKeys].sort());
    expect(moved.find((c) => c.id === onKeys)?.startSec).toBe(3);
    expect(moved.find((c) => c.id === onDrums)?.startSec).toBe(10);
    // Markers copied: A's as they are, B's shifted with "from Blue B" and time-anchored.
    const ms = markersOf(songId);
    expect(ms.map((m) => [m.name, m.startSec, m.note, m.anchor])).toEqual([
      ["Solo", 3, "from Blue B", "time"],
      ["Verse", 4, "", "musical"],
    ]);
    expect(markersOf(a)).toHaveLength(1); // originals stay with the (trashed) source
    // Tempo map from the first source.
    const tm = t.db
      .select()
      .from(schema.tempoMaps)
      .where(eq(schema.tempoMaps.songId, songId))
      .get();
    expect(tm?.bar1OffsetSec).toBe(0.5);
    expect(
      t.db
        .select()
        .from(schema.tempoMapRevisions)
        .where(eq(schema.tempoMapRevisions.id, tm?.revisionId ?? ""))
        .get()?.songId,
    ).toBe(songId);
    // Emptied sources are in the Trash, deleted by the user.
    expect(songRow(a)?.deletedAt).not.toBeNull();
    expect(songRow(b)?.deletedBy).toBe(ids.mara);
    // No mixdown; usage unchanged (rows only).
    expect(mixdownQueued(songId)).toBe(false);
    expect(getUsage(t.db, ids.petr ?? "")).toBe(usage);
    // B's only track is renamed after B ("Keys" → "Blue B").
    expect(liveTracks(songId).map((x) => x.name)).toEqual(["Drums", "Bass", "Blue B"]);
    expect(eventsOf(out.batchId)).toEqual([
      "song.created",
      "song.deleted",
      "song.deleted",
      "track.moved",
      "track.moved",
      "track.moved",
      "track.updated",
    ]);
    expect(
      published
        .filter((e) => e.type === "song.deleted")
        .map((e) => e.data.songId)
        .sort(),
    ).toEqual([a, b].sort());
    expect(published.some((e) => e.type === "song.created" && e.data.songId === songId)).toBe(true);
  });

  it("keeps sources with tracks left, reschedules their mix, and splits within a song", async () => {
    const a = newSong("Split me");
    const drums = track(a, "Drums", ids.petr ?? "");
    const gtr = track(a, "Guitar", ids.petr ?? "", { offset: 48_000 });
    const keep = track(a, "Bass", ids.petr ?? "");
    const res = await call(
      t,
      batchMakeMultitrack,
      {
        body: {
          tracks: [gtr.trackId, drums.trackId],
          name: "Split",
          targetProjectId: ids.other ?? "",
        },
      },
      editor,
    );
    const out = resultOf(res);
    const songId = out.songIds[0] ?? "";
    expect(songRow(songId)?.projectId).toBe(ids.other);
    expect(liveTracks(songId).map((x) => x.id)).toEqual([gtr.trackId, drums.trackId]);
    // One source song: relative offsets kept (the earliest is already 0).
    expect(versionRow(gtr.versionId)?.offsetSamples).toBe(48_000);
    expect(songRow(a)?.deletedAt).toBeNull();
    expect(liveTracks(a).map((x) => x.id)).toEqual([keep.trackId]);
    expect(mixdownQueued(a)).toBe(false);
    expect(
      published.some(
        (e) => e.type === "track.moved" && e.songId === a && e.projectId === ids.project,
      ),
    ).toBe(true);
  });

  it("checks rights: emptying a song needs song.delete, the target song.create", async () => {
    const a = newSong("Rights");
    const own = track(a, "Mine", ids.petr ?? "");
    const target = { name: "X", targetProjectId: ids.project ?? "" };
    // An editor may move tracks, but not empty (and so delete) the song.
    const res = await call(
      t,
      batchMakeMultitrack,
      { body: { tracks: [own.trackId], ...target } },
      editor,
    );
    expect(codeOf(res)).toBe("FORBIDDEN_ITEMS");
    expect(paramsOf(res)?.ids).toBe(own.trackId);
    // Songs need song.delete (managers).
    expect(
      codeOf(await call(t, batchMakeMultitrack, { body: { songs: [a], ...target } }, editor)),
    ).toBe("FORBIDDEN_ITEMS");
    // A contributor may move their own track out of a song with other tracks, but cannot add a
    // song to the project (song.create).
    track(a, "Other", ids.mara ?? "");
    expect(
      codeOf(
        await call(t, batchMakeMultitrack, { body: { tracks: [own.trackId], ...target } }, member),
      ),
    ).toBe("FORBIDDEN");
    // Guests see nothing; an invisible target answers NOT_FOUND with its id.
    expect(
      codeOf(
        await call(t, batchMakeMultitrack, { body: { tracks: [own.trackId], ...target } }, guest),
      ),
    ).toBe("NOT_FOUND");
    const hidden = (await call(t, createProject, { body: { name: "Hidden" } }, admin)).json<{
      project: { id: string };
    }>().project.id;
    t.db
      .update(schema.projectGrants)
      .set({ role: "manager" })
      .where(eq(schema.projectGrants.projectId, hidden))
      .run();
    setProjectGrantRow(t.db, hidden, ids.mara ?? "", "none", ids.boss ?? "");
    const r = await call(
      t,
      batchMakeMultitrack,
      { body: { tracks: [own.trackId], name: "X", targetProjectId: hidden } },
      manager,
    );
    expect(codeOf(r)).toBe("NOT_FOUND");
    expect(paramsOf(r)?.ids).toBe(hidden);
    // Nothing changed.
    expect(trackRow(own.trackId)?.songId).toBe(a);
  });

  it("copies tracks into a new song in another project; the sources stay", async () => {
    const a = newSong("Copy tracks");
    const drums = track(a, "Drums", ids.petr ?? "", { offset: 24_000 });
    const bass = track(a, "Bass", ids.petr ?? "");
    const c = comment(a, drums.trackId, "On drums", 2);
    reply(c, a, "Yes");
    comment(a, null, "Song-wide stays", 1);
    marker(a, "Intro", 0);
    const usage = getUsage(t.db, ids.petr ?? "");
    const assets = t.db.select().from(schema.assets).all().length;
    const out = resultOf(
      await call(
        t,
        batchCopyTracks,
        { body: { tracks: [drums.trackId], name: "Drums only", targetProjectId: ids.other ?? "" } },
        editor,
      ),
    );
    const songId = out.songIds[0] ?? "";
    const [copy] = liveTracks(songId);
    expect(copy?.name).toBe("Drums");
    expect(copy?.id).not.toBe(drums.trackId);
    const v = t.db
      .select()
      .from(schema.trackVersions)
      .where(eq(schema.trackVersions.trackId, copy?.id ?? ""))
      .all();
    expect(v).toHaveLength(1);
    expect(v[0]?.assetId).toBe(versionRow(drums.versionId)?.assetId);
    expect(v[0]?.offsetSamples).toBe(0); // one source song: its earliest start moves to 0
    expect(copy?.currentVersionId).toBe(v[0]?.id);
    // Thread copied (0.5 s earlier) with its reply and reaction; the song-wide comment stays.
    const copied = commentsOf(songId);
    expect(copied.map((x) => x.body).sort()).toEqual(["On drums", "Yes"]);
    expect(copied.find((x) => x.body === "On drums")?.startSec).toBe(1.5);
    expect(copied.find((x) => x.body === "On drums")?.trackId).toBe(copy?.id);
    expect(markersOf(songId).map((m) => m.name)).toEqual(["Intro"]);
    // Sources untouched; files shared, usage counted once.
    expect(liveTracks(a).map((x) => x.id)).toEqual([drums.trackId, bass.trackId]);
    expect(commentsOf(a)).toHaveLength(3);
    expect(t.db.select().from(schema.assets).all().length).toBe(assets);
    expect(getUsage(t.db, ids.petr ?? "")).toBe(usage);
    expect(eventsOf(out.batchId)).toEqual(["song.created", "track.copied"]);
    // Copy needs edit.any in the source.
    expect(
      codeOf(
        await call(
          t,
          batchCopyTracks,
          { body: { tracks: [bass.trackId], name: "No", targetProjectId: ids.other ?? "" } },
          member,
        ),
      ),
    ).toBe("FORBIDDEN_ITEMS");
  });

  it("names the only track of a source song after the song (move)", async () => {
    // Two dropped files (one track each) and a real multitrack song.
    const bass = newSong("Bass");
    const gtr = newSong("Gtr 1");
    const band = newSong("Band take");
    track(bass, "Mix", ids.petr ?? "");
    track(gtr, "Mix", ids.petr ?? "");
    track(band, "Drums", ids.petr ?? "");
    track(band, "Keys", ids.petr ?? "");
    const items = { songs: [bass, gtr, band] };
    const p = MultitrackPreviewSchema.parse(
      (await call(t, batchMultitrackPreview, { body: items }, manager)).json(),
    );
    expect(p.tracks.map((x) => x.name)).toEqual(["Bass", "Gtr 1", "Drums", "Keys"]);
    const out = resultOf(
      await call(
        t,
        batchMakeMultitrack,
        { body: { ...items, name: "Jam", targetProjectId: ids.project ?? "" } },
        manager,
      ),
    );
    const made = liveTracks(out.songIds[0] ?? "");
    expect(made.map((x) => x.name)).toEqual(["Bass", "Gtr 1", "Drums", "Keys"]);
    expect(mixdownQueued(out.songIds[0] ?? "")).toBe(false);
    const updates = t.db
      .select()
      .from(schema.events)
      .all()
      .filter((e) => e.action === "track.updated" && e.details?.includes(out.batchId));
    expect(updates).toHaveLength(2);
    expect(JSON.parse(updates[0]?.details ?? "{}")).toMatchObject({
      changes: ["name"],
      before: { name: "Mix" },
      after: { name: "Bass" },
    });
  });

  it("copies loose files with song names; names from the dialog win", async () => {
    const a = newSong("Vox take");
    const b = newSong("Gtr 2");
    const va = track(a, "Mix", ids.petr ?? "");
    track(b, "Mix", ids.petr ?? "");
    const out = resultOf(
      await call(
        t,
        batchCopyTracks,
        {
          body: {
            songs: [a, b],
            name: "Overdubs",
            names: { [va.trackId]: "  Lead vocal " },
            targetProjectId: ids.project ?? "",
          },
        },
        editor,
      ),
    );
    expect(liveTracks(out.songIds[0] ?? "").map((x) => x.name)).toEqual(["Lead vocal", "Gtr 2"]);
    // The sources keep their tracks.
    expect(liveTracks(a).map((x) => x.name)).toEqual(["Mix"]);
  });

  it("keeps the name of a lone track when the new song has one track", async () => {
    const a = newSong("Alone");
    const only = track(a, "Mix", ids.petr ?? "");
    const out = resultOf(
      await call(
        t,
        batchCopyTracks,
        { body: { tracks: [only.trackId], name: "Alone 2", targetProjectId: ids.project ?? "" } },
        editor,
      ),
    );
    expect(liveTracks(out.songIds[0] ?? "").map((x) => x.name)).toEqual(["Mix"]);
  });
});

describe("copy songs (SPEC §26.6)", () => {
  it("duplicates the song sharing the files; purging the original keeps the copy's files", async () => {
    const a = newSong("Original");
    const bass = track(a, "Bass", ids.petr ?? "");
    const c = comment(a, bass.trackId, "Nice", 4);
    reply(c, a, "Thanks");
    marker(a, "Chorus", 30, true);
    tempo(a, 0.25);
    // A song document (shares its asset too).
    const docAsset = createAsset(t.db, {
      kind: "document",
      originalFilename: "lyrics.md",
      sizeBytes: 10,
      originalHash: randomBytes(32).toString("hex"),
      uploadedBy: ids.petr ?? "",
    }).id;
    const docId = uuidv7();
    t.db
      .insert(schema.documents)
      .values({
        id: docId,
        projectId: ids.project ?? "",
        songId: a,
        title: "Lyrics",
        kind: "markdown",
        createdAt: 1,
      })
      .run();
    const dv = uuidv7();
    t.db
      .insert(schema.documentVersions)
      .values({ id: dv, documentId: docId, number: 1, assetId: docAsset, createdAt: 1 })
      .run();
    t.db
      .update(schema.documents)
      .set({ currentVersionId: dv })
      .where(eq(schema.documents.id, docId))
      .run();
    setSongGrantRow(t.db, a, ids.host ?? "", "viewer", ids.boss ?? "");
    const usage = getUsage(t.db, ids.petr ?? "");
    const assetCount = t.db.select().from(schema.assets).all().length;

    const out = resultOf(
      await call(
        t,
        batchCopySongs,
        { body: { songs: [a], targetProjectId: ids.other ?? "" } },
        editor,
      ),
    );
    const copyId = out.songIds[0] ?? "";
    expect(songRow(copyId)).toMatchObject({ title: "Original", projectId: ids.other });
    const [ct] = liveTracks(copyId);
    const cv = t.db
      .select()
      .from(schema.trackVersions)
      .where(eq(schema.trackVersions.trackId, ct?.id ?? ""))
      .get();
    const assetId = versionRow(bass.versionId)?.assetId ?? "";
    expect(cv?.assetId).toBe(assetId);
    expect(t.db.select().from(schema.assets).all().length).toBe(assetCount);
    expect(getUsage(t.db, ids.petr ?? "")).toBe(usage);
    // Comments with authors, timestamps, replies and reactions.
    const cc = commentsOf(copyId);
    expect(cc.map((x) => [x.body, x.authorUserId, x.createdAt]).sort()).toEqual(
      [
        ["Nice", ids.petr, 1000],
        ["Thanks", ids.mara, 2000],
      ].sort(),
    );
    const replyCopy = cc.find((x) => x.body === "Thanks");
    expect(replyCopy?.parentId).toBe(cc.find((x) => x.body === "Nice")?.id);
    expect(
      t.db
        .select()
        .from(schema.commentReactions)
        .where(eq(schema.commentReactions.commentId, replyCopy?.id ?? ""))
        .all(),
    ).toHaveLength(1);
    expect(cc.find((x) => x.body === "Nice")?.trackId).toBe(ct?.id);
    expect(markersOf(copyId).map((m) => [m.name, m.anchor])).toEqual([["Chorus", "musical"]]);
    expect(
      t.db.select().from(schema.tempoMaps).where(eq(schema.tempoMaps.songId, copyId)).get()
        ?.bar1OffsetSec,
    ).toBe(0.25);
    const docs = t.db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.songId, copyId))
      .all();
    expect(docs.map((d) => [d.title, d.projectId])).toEqual([["Lyrics", ids.other]]);
    expect(
      t.db
        .select()
        .from(schema.documentVersions)
        .where(eq(schema.documentVersions.id, docs[0]?.currentVersionId ?? ""))
        .get()?.assetId,
    ).toBe(docAsset);
    // Grants are not copied.
    expect(
      t.db.select().from(schema.songGrants).where(eq(schema.songGrants.songId, copyId)).all(),
    ).toHaveLength(0);
    expect(eventsOf(out.batchId)).toEqual(["song.copied"]);
    expect(mixdownQueued(copyId)).toBe(false);

    // Removing full quality on the copy affects the original too (shared files).
    resultOrOk(await call(t, batchRemoveLossless, { body: { songs: [copyId] } }, manager));
    expect(versionRow(bass.versionId)?.archivedAt).not.toBeNull();

    // Purging the original keeps the shared asset for the copy.
    await call(t, batchDelete, { body: { songs: [a] } }, manager);
    await call(t, batchPurge, { body: { songs: [a] } }, manager);
    expect(songRow(a)).toBeUndefined();
    expect(
      t.db.select().from(schema.assets).where(eq(schema.assets.id, assetId)).get(),
    ).toBeDefined();
    expect(
      t.db
        .select()
        .from(schema.assetVariants)
        .where(eq(schema.assetVariants.assetId, assetId))
        .all()
        .map((v) => v.variant),
    ).toContain("opus");
    expect(
      t.db.select().from(schema.assets).where(eq(schema.assets.id, docAsset)).get(),
    ).toBeDefined();
  });

  it("needs edit.any in the source and song.create in the target", async () => {
    const a = newSong("Guarded");
    track(a, "Bass", ids.petr ?? "");
    const r = await call(
      t,
      batchCopySongs,
      { body: { songs: [a], targetProjectId: ids.other ?? "" } },
      member,
    );
    expect(codeOf(r)).toBe("FORBIDDEN_ITEMS");
    expect(paramsOf(r)?.ids).toBe(a);
    setProjectGrantRow(t.db, ids.other ?? "", ids.petr ?? "", "contributor", ids.boss ?? "");
    setProjectGrantRow(t.db, ids.project ?? "", ids.petr ?? "", "editor", ids.boss ?? "");
    expect(
      codeOf(
        await call(
          t,
          batchCopySongs,
          { body: { songs: [a], targetProjectId: ids.other ?? "" } },
          member,
        ),
      ),
    ).toBe("FORBIDDEN");
    // Copying into the same project is a duplicate.
    const out = resultOf(
      await call(
        t,
        batchCopySongs,
        { body: { songs: [a], targetProjectId: ids.project ?? "" } },
        member,
      ),
    );
    expect(songRow(out.songIds[0] ?? "")?.projectId).toBe(ids.project);
    t.db
      .delete(schema.projectGrants)
      .where(eq(schema.projectGrants.userId, ids.petr ?? ""))
      .run();
  });
});

describe("move songs (SPEC §26.6)", () => {
  it("moves the song with documents and links; song grants are dropped with events", async () => {
    const a = newSong("Mover");
    const bass = track(a, "Bass", ids.petr ?? "");
    const docId = uuidv7();
    t.db
      .insert(schema.documents)
      .values({
        id: docId,
        projectId: ids.project ?? "",
        songId: a,
        title: "Chords",
        kind: "text",
        createdAt: 1,
      })
      .run();
    const linkId = uuidv7();
    t.db
      .insert(schema.publicLinks)
      .values({
        id: linkId,
        tokenHash: randomBytes(16).toString("hex"),
        tokenSealed: "x",
        scopeType: "song",
        projectId: ids.project ?? "",
        songId: a,
        versions: "current-only",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    setSongGrantRow(t.db, a, ids.host ?? "", "commenter", ids.boss ?? "");
    const out = resultOf(
      await call(
        t,
        batchMoveSongs,
        { body: { songs: [a], targetProjectId: ids.other ?? "" } },
        manager,
      ),
    );
    expect(out.songIds).toEqual([a]);
    expect(songRow(a)?.projectId).toBe(ids.other);
    expect(trackRow(bass.trackId)?.songId).toBe(a);
    expect(
      t.db.select().from(schema.documents).where(eq(schema.documents.id, docId)).get()?.projectId,
    ).toBe(ids.other);
    expect(
      t.db.select().from(schema.publicLinks).where(eq(schema.publicLinks.id, linkId)).get()
        ?.projectId,
    ).toBe(ids.other);
    expect(
      t.db.select().from(schema.songGrants).where(eq(schema.songGrants.songId, a)).all(),
    ).toHaveLength(0);
    expect(eventsOf(out.batchId)).toEqual(["grant.changed", "song.moved"]);
    const [grantEvent] = listEvents(t.db, {
      action: "grant.changed",
      targetId: ids.host ?? "",
    }).filter((e) => e.details?.includes(out.batchId));
    expect(JSON.parse(grantEvent?.details ?? "{}")).toMatchObject({
      scope: "song",
      before: "commenter",
      after: null,
      reason: "moved",
    });
    // Both projects hear about it.
    expect(
      published
        .filter((e) => e.type === "song.moved")
        .map((e) => e.projectId)
        .sort(),
    ).toEqual([ids.project, ids.other].sort());
    // Moving again into the same project is refused.
    expect(
      codeOf(
        await call(
          t,
          batchMoveSongs,
          { body: { songs: [a], targetProjectId: ids.other ?? "" } },
          manager,
        ),
      ),
    ).toBe("BAD_REQUEST");
  });

  it("needs song.delete (managers) in the source", async () => {
    const a = newSong("Stay");
    expect(
      codeOf(
        await call(
          t,
          batchMoveSongs,
          { body: { songs: [a], targetProjectId: ids.other ?? "" } },
          editor,
        ),
      ),
    ).toBe("FORBIDDEN_ITEMS");
    expect(songRow(a)?.projectId).toBe(ids.project);
  });
});

describe("new project from the selection (SPEC §26.6)", () => {
  it("creates the project with the user as manager, in the same batch", async () => {
    const a = newSong("To new");
    track(a, "Bass", ids.petr ?? "");
    const out = resultOf(
      await call(
        t,
        batchCopySongs,
        { body: { songs: [a], newProject: { name: "Fresh" } } },
        manager,
      ),
    );
    const p = t.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, out.projectId))
      .get();
    expect(p).toMatchObject({ name: "Fresh", ownerId: ids.mara });
    expect(
      t.db
        .select()
        .from(schema.projectGrants)
        .where(eq(schema.projectGrants.projectId, out.projectId))
        .all()
        .map((g) => [g.userId, g.role]),
    ).toEqual([[ids.mara, "manager"]]);
    expect(eventsOf(out.batchId)).toEqual(["project.created", "song.copied"]);
    // Moving into a new project works the same way.
    const moved = resultOf(
      await call(
        t,
        batchMoveSongs,
        { body: { songs: [a], newProject: { name: "Fresh 2" } } },
        manager,
      ),
    );
    expect(songRow(a)?.projectId).toBe(moved.projectId);
  });

  it("needs project.create (not for guests)", async () => {
    const a = newSong("Guest's");
    setProjectGrantRow(t.db, ids.project ?? "", ids.host ?? "", "manager", ids.boss ?? "");
    const before = t.db.select().from(schema.projects).all().length;
    expect(
      codeOf(
        await call(t, batchCopySongs, { body: { songs: [a], newProject: { name: "No" } } }, guest),
      ),
    ).toBe("FORBIDDEN");
    expect(t.db.select().from(schema.projects).all().length).toBe(before);
    t.db
      .delete(schema.projectGrants)
      .where(eq(schema.projectGrants.userId, ids.host ?? ""))
      .run();
  });
});

function resultOrOk(res: LightMyRequestResponse) {
  expect(res.statusCode, res.body).toBe(200);
}
