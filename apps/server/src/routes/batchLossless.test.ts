import { randomBytes } from "node:crypto";
import {
  addTrackVersion,
  createAsset,
  createSongRow,
  createTrackWithVersion,
  getBlob,
  getUsage,
  listEvents,
  listVariants,
  putVariant,
  schema,
  setAssetProbe,
  setAssetStatus,
  setProjectGrantRow,
  type Probe,
} from "@bandroom/server-core";
import {
  ApiErrorSchema,
  batchRemoveLossless,
  batchRemoveLosslessPreview,
  createProject,
  getSongOfflineManifest,
  listProjectSongs,
  listSongTracks,
  listTrackVersions,
  RemoveLosslessPreviewSchema,
  retryTrackVersion,
  type SongSummary,
  type StackVersion,
  type StreamEvent,
  type Track,
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

/** Stores a fake blob of `size` bytes (no file). */
function blob(size: number): string {
  const hash = randomBytes(32).toString("hex");
  t.db
    .insert(schema.blobs)
    .values({ hash, sizeBytes: size, storageKey: `x/${hash}`, refCount: 0, createdAt: 0 })
    .run();
  return hash;
}

const probe = (lossless: boolean): Probe => ({
  container: lossless ? "wav" : "mp3",
  codec: lossless ? "pcm_s24le" : "mp3",
  lossless,
  sampleRate: 48_000,
  channels: 2,
  sampleFormat: "s32",
  bitDepth: lossless ? 24 : 0,
  isFloat: false,
  durationSamples: 48_000,
  durationSec: 1,
  tags: {},
  timeReference: null,
});

interface AssetSpec {
  /** flac blob (shared when given), default a new 1000 B blob; null for none. */
  flac?: string | null;
  wavmeta?: boolean;
  /** A lossy source: an original (500 B) and no FLAC. */
  lossy?: boolean;
  status?: "ready" | "processing";
  /** The opus variant's bitrate (default 96, the standard preset). */
  opusKbps?: number;
}

/** An audio asset: flac (1000 B) + wavmeta (10 B) or an MP3 original (500 B), and opus (100 B). */
function asset(uploadedBy: string, spec: AssetSpec = {}): string {
  const a = createAsset(t.db, {
    kind: "audio",
    originalFilename: spec.lossy ? "x.mp3" : "x.wav",
    sizeBytes: 1,
    originalHash: randomBytes(32).toString("hex"),
    uploadedBy,
  });
  if (spec.lossy) putVariant(t.db, a.id, "original", blob(500));
  else if (spec.flac !== null) putVariant(t.db, a.id, "flac", spec.flac ?? blob(1000));
  if (spec.wavmeta) putVariant(t.db, a.id, "wavmeta", blob(10));
  putVariant(t.db, a.id, "opus", blob(100), { bitrate: spec.opusKbps ?? 96, channels: 2 });
  setAssetProbe(t.db, a.id, probe(!spec.lossy));
  setAssetStatus(t.db, a.id, spec.status ?? "ready");
  return a.id;
}

function track(songId: string, name: string, by: string, spec: AssetSpec = {}) {
  const created = createTrackWithVersion(t.db, {
    songId,
    name,
    assetId: asset(by, spec),
    uploadedBy: by,
  });
  return {
    trackId: created.track.id,
    versionId: created.version.id,
    assetId: created.version.assetId,
  };
}

const newSong = (title: string) =>
  createSongRow(t.db, { projectId: ids.project ?? "", title, createdBy: ids.boss ?? "" }).id;

const preview = async (body: object, cookie = admin) => {
  const res = await call(t, batchRemoveLosslessPreview, { body }, cookie);
  expect(res.statusCode).toBe(200);
  return RemoveLosslessPreviewSchema.parse(res.json());
};

const versionRow = (id: string) =>
  t.db.select().from(schema.trackVersions).where(eq(schema.trackVersions.id, id)).get();

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

describe("remove full quality: preview (SPEC §26.4)", () => {
  it("counts files, usage and disk space, lossy sources, copies and skipped versions", async () => {
    const song = newSong("Preview");
    const shared = blob(1000); // the same FLAC stored once for two uploads (dedupe)
    const a = track(song, "Bass", ids.petr ?? "", { flac: shared, wavmeta: true });
    const b = track(song, "Keys", ids.petr ?? "", { flac: shared });
    const mp3 = track(song, "Demo", ids.petr ?? "", { lossy: true });
    const busy = track(song, "Vox", ids.petr ?? "", { status: "processing" });
    const done = track(song, "Old", ids.petr ?? "", { flac: null });
    // A copy in another song shares the Bass asset (SPEC §26.6).
    const other = newSong("Other");
    createTrackWithVersion(t.db, {
      songId: other,
      name: "Bass copy",
      assetId: a.assetId,
      uploadedBy: ids.petr ?? "",
    });

    expect(await preview({ songs: [song] })).toEqual({
      versions: 3,
      files: { flac: 2, original: 1, wavmeta: 1 },
      usageBytes: 1000 + 1000 + 10 + 500,
      bytesFreed: 1000 + 10 + 500, // the shared FLAC file goes once
      lossySources: {
        count: 1,
        items: [{ id: mp3.versionId, number: 1, trackName: "Demo", songTitle: "Preview" }],
      },
      sharedCopies: 1,
      skipped: { notReady: 1, alreadyLossy: 1 },
      reencode: 0,
      currentOpus: [{ kbps: 96, count: 3 }],
    });

    // Only one of the two users of the shared FLAC: usage drops, but no disk space is freed.
    expect(await preview({ versions: [b.versionId] })).toMatchObject({
      versions: 1,
      usageBytes: 1000,
      bytesFreed: 0,
      sharedCopies: 0,
    });
    // Items overlap (a track and its version): each version counts once.
    expect(
      await preview({ tracks: [busy.trackId, done.trackId, a.trackId], versions: [a.versionId] }),
    ).toMatchObject({ versions: 1, skipped: { notReady: 1, alreadyLossy: 1 } });
  });
});

describe("remove full quality: permissions (SPEC §26.4)", () => {
  it("lets managers and admins remove anyone's, uploaders only their own", async () => {
    const song = newSong("Rights");
    const own = track(song, "Mine", ids.petr ?? "");
    const theirs = track(song, "Theirs", ids.eda ?? "");
    // Contributor: own version yes, others' version and mixed track/song no.
    expect(
      codeOf(
        await call(t, batchRemoveLosslessPreview, { body: { versions: [own.versionId] } }, member),
      ),
    ).toBe("ok");
    const res = await call(
      t,
      batchRemoveLossless,
      { body: { versions: [own.versionId, theirs.versionId], songs: [song] } },
      member,
    );
    expect(codeOf(res)).toBe("FORBIDDEN_ITEMS");
    expect(paramsOf(res)).toMatchObject({ count: 2 });
    expect(String(paramsOf(res)?.ids).split(",").sort()).toEqual([song, theirs.versionId].sort());
    expect(listVariants(t.db, own.assetId).some((v) => v.variant === "flac")).toBe(true);
    // An editor is not enough for others' versions; a track of their own uploads is.
    expect(
      codeOf(
        await call(t, batchRemoveLosslessPreview, { body: { tracks: [own.trackId] } }, editor),
      ),
    ).toBe("FORBIDDEN_ITEMS");
    expect(
      codeOf(
        await call(t, batchRemoveLosslessPreview, { body: { tracks: [theirs.trackId] } }, editor),
      ),
    ).toBe("ok");
    expect(
      codeOf(await call(t, batchRemoveLosslessPreview, { body: { songs: [song] } }, manager)),
    ).toBe("ok");
    // Not visible to guests; unknown ids are NOT_FOUND.
    expect(
      codeOf(await call(t, batchRemoveLosslessPreview, { body: { songs: [song] } }, guest)),
    ).toBe("NOT_FOUND");
    expect(
      codeOf(await call(t, batchRemoveLosslessPreview, { body: { songs: ["nope"] } }, admin)),
    ).toBe("NOT_FOUND");
  });

  it("refuses items in the Trash and validates the body", async () => {
    const song = newSong("Trashed");
    const v = track(song, "Gone", ids.petr ?? "");
    t.db
      .update(schema.trackVersions)
      .set({ deletedAt: 1 })
      .where(eq(schema.trackVersions.id, v.versionId))
      .run();
    expect(
      codeOf(await call(t, batchRemoveLossless, { body: { versions: [v.versionId] } }, admin)),
    ).toBe("NOT_FOUND");
    expect(codeOf(await call(t, batchRemoveLossless, { body: {} }, admin))).toBe(
      "VALIDATION_FAILED",
    );
  });
});

describe("remove full quality: apply (SPEC §26.4)", () => {
  it("removes the files, frees usage, marks versions, logs events and notifies", async () => {
    const song = newSong("Apply");
    const wav = track(song, "Bass", ids.petr ?? "", { wavmeta: true });
    const mp3 = track(song, "Demo", ids.petr ?? "", { lossy: true });
    const kept = track(song, "Keys", ids.eda ?? "");
    const other = newSong("Copy");
    const copy = createTrackWithVersion(t.db, {
      songId: other,
      name: "Bass copy",
      assetId: wav.assetId,
      uploadedBy: ids.petr ?? "",
    });
    const flacHash = listVariants(t.db, wav.assetId).find((v) => v.variant === "flac")?.blobHash;
    const usage = getUsage(t.db, ids.petr ?? "");

    const songs = async () =>
      (await call(t, listProjectSongs, { params: { id: ids.project ?? "" } }, admin)).json<{
        songs: SongSummary[];
      }>().songs;
    expect((await songs()).find((s) => s.id === song)?.lossy).toBe("partial");

    const res = await call(
      t,
      batchRemoveLossless,
      { body: { versions: [wav.versionId, mp3.versionId] } },
      member,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      batchId: string;
      count: number;
      usageBytes: number;
      bytesFreed: number;
    }>();
    expect(body).toMatchObject({
      ok: true,
      count: 2,
      usageBytes: 1000 + 10 + 500,
      bytesFreed: 1510,
    });

    expect(listVariants(t.db, wav.assetId).map((v) => v.variant)).toEqual(["opus"]);
    expect(listVariants(t.db, mp3.assetId).map((v) => v.variant)).toEqual(["opus"]);
    expect(getUsage(t.db, ids.petr ?? "")).toBe(usage - 1510);
    expect(getBlob(t.db, flacHash ?? "")?.refCount).toBe(0);
    expect(versionRow(wav.versionId)).toMatchObject({ archivedBy: ids.petr });
    expect(versionRow(copy.version.id)?.archivedAt).not.toBeNull();
    expect(versionRow(kept.versionId)?.archivedAt).toBeNull();

    // One event per version (the copy marked), all with the batch id.
    const events = listEvents(t.db, { action: "version.lossless_removed" }).map((e) => ({
      targetId: e.targetId,
      details: JSON.parse(e.details ?? "{}") as Record<string, unknown>,
    }));
    expect(events.map((e) => e.targetId).sort()).toEqual(
      [wav.versionId, mp3.versionId, copy.version.id].sort(),
    );
    for (const e of events) expect(e.details).toMatchObject({ batchId: body.batchId });
    expect(events.find((e) => e.targetId === copy.version.id)?.details).toMatchObject({
      copy: true,
    });
    // SSE for both songs, so open pages refresh.
    expect(
      published
        .filter((e) => e.type === "version.lossless_removed")
        .map((e) => e.songId)
        .sort(),
    ).toEqual([song, other].sort());

    // DTO: archived with who and when; only Opus to download; the song list says "Lossy".
    const tracks = (await call(t, listSongTracks, { params: { id: song } }, admin)).json<{
      tracks: Track[];
    }>().tracks;
    const bass = tracks.find((tr) => tr.id === wav.trackId)?.current;
    expect(bass?.archived).toMatchObject({ by: { id: ids.petr, displayName: "Petr" } });
    expect(bass?.media?.lossless).toBe(true); // the source was lossless
    expect(bass?.downloads).toEqual(["opus"]);
    expect(bass?.variants.flac).toBeNull();
    expect(tracks.find((tr) => tr.id === kept.trackId)?.current?.archived).toBeNull();
    const stack = (await call(t, listTrackVersions, { params: { id: wav.trackId } }, admin)).json<{
      versions: StackVersion[];
    }>().versions;
    expect(stack[0]?.archived?.at).toBe(versionRow(wav.versionId)?.archivedAt);
    expect((await songs()).find((s) => s.id === song)?.lossy).toBe("partial");
    expect((await songs()).find((s) => s.id === other)?.lossy).toBe("all");

    // Downloads of full quality answer LOSSLESS_REMOVED; offline lossless lists only Opus.
    for (const format of ["flac", "wav", "original"]) {
      const dl = await t.app.inject({
        url: `/api/v1/track-versions/${wav.versionId}/download?format=${format}`,
        headers: { cookie: admin },
      });
      expect(dl.statusCode).toBe(410);
      expect(ApiErrorSchema.parse(dl.json()).code).toBe("LOSSLESS_REMOVED");
    }
    const manifest = (
      await call(
        t,
        getSongOfflineManifest,
        { params: { id: song }, query: { quality: "normal", lossless: "true" } },
        admin,
      )
    ).json<{ song: { blobs: { hash: string }[] } }>().song;
    const wavHashes = new Set(listVariants(t.db, wav.assetId).map((v) => v.blobHash));
    expect(manifest.blobs.filter((b) => wavHashes.has(b.hash))).toHaveLength(1); // opus only
    const keysFlac = listVariants(t.db, kept.assetId).find((v) => v.variant === "flac")?.blobHash;
    expect(manifest.blobs.some((b) => b.hash === keysFlac)).toBe(true);

    // A repeated call changes nothing.
    const again = await call(t, batchRemoveLossless, { body: { songs: [song] } }, admin);
    expect(again.json()).toMatchObject({ count: 1 }); // only Keys was left
    expect(versionRow(kept.versionId)?.archivedBy).toBe(ids.boss);
  });

  it("refuses to retry the processing of a version whose full quality was removed", async () => {
    const song = newSong("Retry");
    const v = track(song, "Bass", ids.petr ?? "");
    await call(t, batchRemoveLossless, { body: { versions: [v.versionId] } }, admin);
    setAssetStatus(t.db, v.assetId, "failed", "boom");
    const res = await call(t, retryTrackVersion, { params: { id: v.versionId } }, admin);
    expect(codeOf(res)).toBe("LOSSLESS_REMOVED");
  });

  it("works on versions added to an existing track (a stack)", async () => {
    const song = newSong("Stack");
    const v1 = track(song, "Bass", ids.petr ?? "");
    const v2 = addTrackVersion(t.db, {
      trackId: v1.trackId,
      assetId: asset(ids.petr ?? ""),
      uploadedBy: ids.petr ?? "",
    });
    const res = await call(t, batchRemoveLossless, { body: { tracks: [v1.trackId] } }, member);
    expect(res.json()).toMatchObject({ count: 2 });
    expect(versionRow(v2.id)?.archivedAt).not.toBeNull();
  });
});

describe("remove full quality with a quality choice (SPEC §28.3)", () => {
  it("previews which versions are re-encoded and the current bitrates", async () => {
    const song = newSong("Quality");
    track(song, "Bass", ids.petr ?? "");
    track(song, "Keys", ids.petr ?? "", { opusKbps: 128 });
    expect(await preview({ songs: [song] })).toMatchObject({
      versions: 2,
      reencode: 0,
      currentOpus: [
        { kbps: 128, count: 1 },
        { kbps: 96, count: 1 },
      ],
    });
    expect((await preview({ songs: [song], quality: "high" })).reencode).toBe(1);
    expect((await preview({ songs: [song], quality: "low" })).reencode).toBe(2);
    expect((await preview({ songs: [song], quality: "standard" })).reencode).toBe(1);
  });

  it("removes at once what already has the bitrate and queues one re-encode per asset", async () => {
    const song = newSong("Queue");
    const same = track(song, "Bass", ids.petr ?? "", { opusKbps: 128 });
    const other = track(song, "Keys", ids.petr ?? "");
    // A copy of Keys in the same song shares its asset: one job.
    const copy = createTrackWithVersion(t.db, {
      songId: song,
      name: "Keys copy",
      assetId: other.assetId,
      uploadedBy: ids.petr ?? "",
    });
    const res = await call(
      t,
      batchRemoveLossless,
      { body: { songs: [song], quality: "high" } },
      manager,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, count: 1, reencoding: 2 });
    expect(versionRow(same.versionId)).toMatchObject({ archivedReason: "removed" });
    expect(versionRow(other.versionId)?.archivedAt).toBeNull();
    expect(versionRow(copy.version.id)?.archivedAt).toBeNull();
    const jobs = t.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.type, "audio.reencode"))
      .all()
      .filter((j) => j.payload.includes(other.assetId));
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0]?.payload ?? "{}")).toMatchObject({
      assetId: other.assetId,
      quality: "high",
      userId: ids.mara,
      removeLossless: true,
    });
    const requested = listEvents(t.db, { action: "version.reencode_requested" }).filter((e) =>
      [other.versionId, copy.version.id].includes(e.targetId ?? ""),
    );
    expect(requested).toHaveLength(2);
    expect(JSON.parse(requested[0]?.details ?? "{}")).toMatchObject({ quality: "high", kbps: 128 });
  });
});
