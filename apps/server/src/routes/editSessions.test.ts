import { randomBytes } from "node:crypto";
import {
  addTrackVersion,
  createAsset,
  createSongRow,
  createTrackWithVersion,
  getUserById,
  listEditSessionRows,
  listEvents,
  putVariant,
  schema,
  setAssetStatus,
  setProjectGrantRow,
  softDeleteTrack,
} from "@bandroom/server-core";
import {
  API_PREFIX,
  ApiErrorSchema,
  batchCopyTracks,
  batchDelete,
  batchMakeMultitrack,
  batchMoveSongs,
  batchPurge,
  batchRemoveLossless,
  batchRestore,
  cancelEditSession,
  CONTENT_ROLES,
  convertMarkers,
  createComment,
  createMarker,
  createMixerSnapshot,
  createProject,
  createSongLink,
  DEFAULT_EDIT_FADES,
  deleteComment,
  deleteMarker,
  deleteSong,
  deleteSongTempo,
  deleteTrack,
  deleteTrackVersion,
  EditSessionSchema,
  FOLLOW_ALL,
  getEditSession,
  getSong,
  hasCapability,
  importSongTempoMidi,
  listSongTracks,
  lockSong,
  MAX_EDIT_OPS,
  putSongMixer,
  putSongTempo,
  recordSongOffline,
  recordSongVisit,
  reorderSongTracks,
  reorderTrackVersions,
  replay,
  resolveComment,
  restoreComment,
  restoreMarker,
  restoreTempoRevision,
  retryTrackVersion,
  saveEditSession,
  setCommentReaction,
  setCurrentTrackVersion,
  setSongFollow,
  startEditSession,
  takeOverEditSession,
  unlockSong,
  updateComment,
  updateMarker,
  updateSong,
  updateTrack,
  updateTrackVersion,
  uuidv7,
  type ContentRole,
  type ContractDef,
  type EditOp,
  type EditSession,
  type Song,
  type StreamEvent,
} from "@bandroom/shared";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFilter } from "./stream";
import {
  call,
  createTestApp,
  loginAs,
  seedUser,
  tusUpload,
  type TestApp,
} from "../testing/testApp";

/** Edit sessions and the edit lock (SPEC §24.7, §24.11–§24.13, §24.17 API). */

const SEC = 48_000;
let t: TestApp;
let admin: string;
let eda: string; // editor, starts the session
let bossId: string;
let edaId: string;
let jana: string; // second editor
let janaId: string;
let petr: string; // contributor
let mara: string; // manager
let projectId: string;
let otherProjectId: string;
let songId: string;
let trackA: string;
let trackB: string;
let versionA: string;
/** A second, non-current version of track A. */
let versionA2: string;
let trashedTrack: string;
let markerId: string;
let commentId: string;
const published: StreamEvent[] = [];

const codeOf = (res: LightMyRequestResponse) =>
  res.statusCode >= 400 ? ApiErrorSchema.parse(res.json()).code : "ok";
const sessionOf = (res: LightMyRequestResponse): EditSession =>
  EditSessionSchema.parse(res.json<{ session: unknown }>().session);
const songOf = async (cookie: string, id = songId) =>
  (await call(t, getSong, { params: { id } }, cookie)).json<{ song: Song }>().song;

function blob(size: number): string {
  const hash = randomBytes(32).toString("hex");
  t.db
    .insert(schema.blobs)
    .values({ hash, sizeBytes: size, storageKey: `x/${hash}`, refCount: 0, createdAt: 0 })
    .run();
  return hash;
}

/** An audio asset with an Opus of `seconds`; ready unless `status` says otherwise. */
function audio(
  by: string,
  seconds = 10,
  status: "ready" | "processing" | "failed" = "ready",
): string {
  const a = createAsset(t.db, {
    kind: "audio",
    originalFilename: "x.wav",
    sizeBytes: 1,
    originalHash: randomBytes(32).toString("hex"),
    uploadedBy: by,
  });
  putVariant(t.db, a.id, "flac", blob(1000));
  putVariant(t.db, a.id, "opus", blob(100), {
    codec: "opus",
    channels: 2,
    durationSamples48k: seconds * SEC,
  });
  setAssetStatus(t.db, a.id, status);
  return a.id;
}

function track(song: string, name: string, by: string, seconds = 10) {
  return createTrackWithVersion(t.db, {
    songId: song,
    name,
    assetId: audio(by, seconds),
    uploadedBy: by,
  });
}

function op(partial: Partial<EditOp> & Pick<EditOp, "type">, userId = edaId): EditOp {
  return {
    id: uuidv7(),
    at: Date.now(),
    userId,
    timeline: FOLLOW_ALL,
    ...partial,
  } as EditOp;
}
const split = (frame: number, tracks = [trackA]) => op({ type: "split", frames: [frame], tracks });
const cut = (start: number, end: number, tracks = [trackA, trackB]) =>
  op({ type: "cut", range: { start, end }, tracks, fades: DEFAULT_EDIT_FADES });
const gain = (gainDb: number) =>
  op({
    type: "gain",
    range: { start: SEC, end: 2 * SEC },
    tracks: [trackA],
    gainDb,
    fades: { fadeIn: 0, fadeOut: 0, crossfade: 0 },
  });

const start = (cookie = eda, id = songId) => call(t, startEditSession, { params: { id } }, cookie);
const read = (cookie = eda, id = songId) => call(t, getEditSession, { params: { id } }, cookie);
const save = (id: string, body: { rev: number; ops: EditOp[]; cursor?: number }, cookie = eda) =>
  call(
    t,
    saveEditSession,
    {
      params: { id },
      body: {
        rev: body.rev,
        ops: body.ops,
        cursor: body.cursor ?? body.ops.length,
        options: { fades: DEFAULT_EDIT_FADES, overlap: "mix", timeline: FOLLOW_ALL, snap: "beat" },
      },
    },
    cookie,
  );
const takeOver = (id: string, cookie = jana) =>
  call(t, takeOverEditSession, { params: { id } }, cookie);
const cancel = (id: string, cookie = jana) =>
  call(t, cancelEditSession, { params: { id } }, cookie);

/** A public link visitor below `/l/:token`. */
function visit(
  token: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  cookie?: string,
  body?: unknown,
) {
  return t.app.inject({
    method,
    url: `${t.basePath}${API_PREFIX}/l/${token}${path}`,
    headers: { "x-requested-with": "bandroom", ...(cookie && { cookie }) },
    ...(body !== undefined && { payload: body as Record<string, unknown> }),
  });
}

beforeAll(async () => {
  t = await createTestApp();
  const boss = await seedUser(t, "boss", "admin");
  const e = await seedUser(t, "eda", "member");
  const j = await seedUser(t, "jana", "member");
  const p = await seedUser(t, "petr", "member");
  bossId = boss.id;
  edaId = e.id;
  janaId = j.id;
  admin = await loginAs(t, "boss");
  eda = await loginAs(t, "eda");
  jana = await loginAs(t, "jana");
  petr = await loginAs(t, "petr");
  const m = await seedUser(t, "mara", "member");
  mara = await loginAs(t, "mara");
  const project = async (name: string) =>
    (await call(t, createProject, { body: { name } }, admin)).json<{ project: { id: string } }>()
      .project.id;
  projectId = await project("Album");
  otherProjectId = await project("Other");
  for (const id of [projectId, otherProjectId]) {
    setProjectGrantRow(t.db, id, e.id, "editor", boss.id);
    setProjectGrantRow(t.db, id, j.id, "editor", boss.id);
    setProjectGrantRow(t.db, id, m.id, "manager", boss.id);
  }
  songId = createSongRow(t.db, { projectId, title: "Song", createdBy: boss.id }).id;
  const a = track(songId, "Guitar", e.id);
  trackA = a.track.id;
  versionA = a.version.id;
  trackB = track(songId, "Bass", p.id, 8).track.id;
  // A newer version uploaded but not current, and a track in the Trash.
  versionA2 = addTrackVersion(t.db, { trackId: trackA, assetId: audio(e.id), uploadedBy: e.id }).id;
  t.db.$client
    .prepare("UPDATE tracks SET current_version_id = ? WHERE id = ?")
    .run(versionA, trackA);
  trashedTrack = track(songId, "Old", e.id).track.id;
  softDeleteTrack(t.db, trashedTrack, Date.now(), e.id);
  markerId = (
    await call(
      t,
      createMarker,
      { params: { id: songId }, body: { type: "marker", name: "A", color: "red", startSec: 1 } },
      petr,
    )
  ).json<{ marker: { id: string } }>().marker.id;
  commentId = (
    await call(t, createComment, { params: { id: songId }, body: { body: "Hi" } }, petr)
  ).json<{ comment: { id: string } }>().comment.id;
  t.hub.subscribe({ canSee: () => true, send: () => undefined }, null);
  const publish = t.hub.publish.bind(t.hub);
  t.hub.publish = (ev, now) => {
    published.push(ev);
    return publish(ev, now);
  };
});
afterAll(async () => {
  await t.close();
});

describe("edit session lifecycle (SPEC §24.7)", () => {
  let id = "";
  let rev = 0;
  let ops: EditOp[] = [];

  it("starts with a base of the current, ready versions", async () => {
    expect((await read()).json()).toEqual({ session: null });
    const res = await start();
    expect(res.statusCode).toBe(200);
    const s = sessionOf(res);
    id = s.id;
    rev = s.rev ?? -1;
    expect(s).toMatchObject({
      songId,
      status: "open",
      owner: { id: edaId, name: "Eda" },
      ops: [],
      cursor: 0,
      rev: 0,
    });
    expect(s.base?.tracks.map((b) => [b.trackId, b.versionId, b.lengthFrames])).toEqual([
      [trackA, versionA, 10 * SEC],
      [trackB, expect.any(String), 8 * SEC],
    ]);
    expect(s.base?.tracks[0]?.clip).toMatchObject({ startFrame: 0, lengthFrames: 10 * SEC });
    expect(listEvents(t.db, { action: "edit.session_started", targetId: id })).toHaveLength(1);
    expect(published).toContainEqual(
      expect.objectContaining({
        type: "edit.changed",
        songId,
        data: expect.objectContaining({
          status: "open",
          owner: { id: edaId, name: "Eda" },
        }) as object,
      }),
    );
    expect(published).toContainEqual(
      expect.objectContaining({ type: "song.updated", songId, data: { editing: true } }),
    );
  });

  it("refuses a second session", async () => {
    for (const cookie of [eda, jana, admin])
      expect(codeOf(await start(cookie))).toBe("EDIT_SESSION_OPEN");
    expect(listEditSessionRows(t.db, songId)).toHaveLength(1);
  });

  it("shows the session in full to its owner only", async () => {
    expect(sessionOf(await read(eda)).base).toBeDefined();
    const other = sessionOf(await read(petr));
    expect(other).toEqual({
      id,
      songId,
      status: "open",
      owner: { id: edaId, name: "Eda" },
      since: expect.any(Number) as number,
      updatedAt: expect.any(Number) as number,
      outcome: null,
      renders: [],
      error: null,
    });
  });

  it("shows the lock on the song DTO", async () => {
    expect((await songOf(petr)).editing).toEqual({
      sessionId: id,
      status: "open",
      since: expect.any(Number) as number,
      by: { id: edaId, name: "Eda" },
    });
  });

  it("saves with the rev, validated by a replay", async () => {
    ops = [split(3 * SEC), cut(SEC, 2 * SEC)];
    const res = await save(id, { rev, ops, cursor: 1 });
    expect(res.statusCode).toBe(200);
    const s = sessionOf(res);
    expect(s).toMatchObject({ rev: rev + 1, cursor: 1, options: { snap: "beat" } });
    expect(s.ops).toHaveLength(2);
    rev = s.rev ?? -1;
    expect(published.at(-1)).toMatchObject({
      type: "edit.changed",
      data: { sessionId: id, status: "open", rev },
    });
    // A stale rev conflicts.
    expect(codeOf(await save(id, { rev: rev - 1, ops }))).toBe("EDIT_CONFLICT");
  });

  it("logs saves at most once per minute", async () => {
    const res = await save(id, { rev, ops, cursor: 2 });
    rev = sessionOf(res).rev ?? -1;
    const logged = listEvents(t.db, { action: "edit.session_saved", targetId: id });
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]?.details ?? "{}")).toMatchObject({ ops: 2, cursor: 1 });
  });

  it("refuses new ops that do not apply", async () => {
    const before = rev;
    for (const bad of [split(0), split(SEC, ["nope"]), split(20 * SEC)]) {
      const res = await save(id, { rev, ops: [...ops, bad] });
      expect(codeOf(res)).toBe("VALIDATION_FAILED");
      expect(ApiErrorSchema.parse(res.json()).params).toMatchObject({ index: 2 });
    }
    // A redo-tail op is checked too.
    expect(codeOf(await save(id, { rev, ops: [...ops, split(0)], cursor: 2 }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(sessionOf(await read()).rev).toBe(before);
  });

  it("lets only the owner save", async () => {
    expect(codeOf(await save(id, { rev, ops }, jana))).toBe("NOT_SESSION_OWNER");
    expect(codeOf(await save(id, { rev, ops }, admin))).toBe("NOT_SESSION_OWNER");
    expect(codeOf(await save(id, { rev, ops }, petr))).toBe("FORBIDDEN");
  });

  it("is taken over by another editor; the old owner can no longer save", async () => {
    const res = await takeOver(id);
    expect(res.statusCode).toBe(200);
    const s = sessionOf(res);
    expect(s.owner).toEqual({ id: janaId, name: "Jana" });
    expect(s.ops).toHaveLength(2); // nothing lost
    expect(codeOf(await save(id, { rev, ops }))).toBe("NOT_SESSION_OWNER");
    expect(
      JSON.parse(
        listEvents(t.db, { action: "edit.session_taken_over", targetId: id })[0]?.details ?? "{}",
      ),
    ).toEqual({ from: edaId, to: janaId });
    expect((await songOf(petr)).editing?.by).toEqual({ id: janaId, name: "Jana" });
    // Taking over one's own session changes nothing.
    expect(sessionOf(await takeOver(id)).rev).toBe(s.rev);
    rev = s.rev ?? -1;
    const saved = await save(id, { rev, ops: [...ops, split(5 * SEC, [trackB])] }, jana);
    expect(saved.statusCode).toBe(200);
    rev = sessionOf(saved).rev ?? -1;
  });

  it("is cancelled by the old owner too, which releases the lock", async () => {
    const res = await cancel(id, eda);
    expect(res.statusCode).toBe(200);
    expect(sessionOf(res).status).toBe("cancelled");
    expect((await read()).json()).toEqual({ session: null });
    expect((await songOf(petr)).editing).toBeNull();
    expect(codeOf(await cancel(id))).toBe("EDIT_SESSION_STATE");
    expect(codeOf(await takeOver(id))).toBe("EDIT_SESSION_STATE");
    expect(codeOf(await save(id, { rev, ops }, jana))).toBe("EDIT_SESSION_STATE");
    expect(listEvents(t.db, { action: "edit.session_cancelled", targetId: id })).toHaveLength(1);
    expect(published.at(-1)).toMatchObject({ type: "song.updated", data: { editing: false } });
  });
});

describe("SSE (SPEC §24.11)", () => {
  it("delivers edit.changed to the song's viewers only", async () => {
    const event = published.find((e) => e.type === "edit.changed");
    if (!event) throw new Error("no edit.changed");
    const stranger = await seedUser(t, "stranger", "guest");
    const viewer = getUserById(t.db, edaId);
    const outsider = getUserById(t.db, stranger.id);
    if (!viewer || !outsider) throw new Error("users missing");
    expect(makeFilter({ db: t.db }, viewer)(event)).toBe(true);
    expect(makeFilter({ db: t.db }, outsider)(event)).toBe(false);
  });
});

describe("folding (SPEC §24.7)", () => {
  it("folds the oldest ops into the base beyond 2 000", async () => {
    const s = sessionOf(await start());
    const ops = [split(5 * SEC)];
    for (let i = 0; i < MAX_EDIT_OPS + 4; i++) ops.push(gain(i % 2 ? -3 : -6));
    const res = await save(s.id, { rev: 0, ops });
    expect(res.statusCode).toBe(200);
    const saved = sessionOf(res);
    expect(saved.ops).toHaveLength(MAX_EDIT_OPS);
    expect(saved.cursor).toBe(MAX_EDIT_OPS);
    expect(saved.base?.foldedOps).toBe(5);
    expect(saved.base?.tracks[0]?.folded).toBeDefined();
    if (!saved.base || !s.base || !saved.ops) throw new Error("missing state");
    // The same clips as before folding.
    expect(replay(saved.base, saved.ops).tracks).toEqual(replay(s.base, ops).tracks);
    // The client continues from the folded state.
    const next = await save(s.id, { rev: saved.rev ?? 0, ops: [...saved.ops, split(7 * SEC)] });
    expect(next.statusCode).toBe(200);
    expect(sessionOf(next).ops).toHaveLength(MAX_EDIT_OPS);
    expect(sessionOf(next).base?.foldedOps).toBe(6);
    expect(codeOf(await cancel(s.id, eda))).toBe("ok");
  });
});

describe("starting is refused (SPEC §24.7)", () => {
  it("on a locked song", async () => {
    expect(codeOf(await call(t, lockSong, { params: { id: songId } }, eda))).toBe("ok");
    for (const cookie of [eda, admin]) expect(codeOf(await start(cookie))).toBe("SONG_LOCKED");
    expect(codeOf(await call(t, unlockSong, { params: { id: songId } }, eda))).toBe("ok");
  });

  it("while a current version is processing, and without audio", async () => {
    const song = createSongRow(t.db, { projectId, title: "Busy", createdBy: edaId }).id;
    const busy = createTrackWithVersion(t.db, {
      songId: song,
      name: "Vox",
      assetId: audio(edaId, 5, "processing"),
      uploadedBy: edaId,
    });
    expect(codeOf(await start(eda, song))).toBe("PROCESSING_SOURCE");
    setAssetStatus(t.db, busy.version.assetId, "failed");
    const res = await start(eda, song);
    expect(codeOf(res)).toBe("VALIDATION_FAILED");
    expect(ApiErrorSchema.parse(res.json()).params).toEqual({ reason: "empty" });
  });
});

/** Every request the edit lock freezes, with a body that is valid for it. */
const FROZEN: [string, ContractDef, () => Record<string, unknown>][] = [
  ["edit song", updateSong, () => ({ params: { id: songId }, body: { key: "A minor" } })],
  ["lock song", lockSong, () => ({ params: { id: songId } })],
  ["unlock song", unlockSong, () => ({ params: { id: songId } })],
  ["rename track", updateTrack, () => ({ params: { id: trackA }, body: { name: "Gtr" } })],
  [
    "track default gain",
    updateTrack,
    () => ({ params: { id: trackA }, body: { defaultGainDb: -3 } }),
  ],
  ["delete track", deleteTrack, () => ({ params: { id: trackB } })],
  [
    "reorder tracks",
    reorderSongTracks,
    () => ({ params: { id: songId }, body: { trackIds: [trackB, trackA] } }),
  ],
  [
    "set current",
    setCurrentTrackVersion,
    () => ({ params: { id: trackA }, body: { versionId: versionA2 } }),
  ],
  [
    "reorder versions",
    reorderTrackVersions,
    () => ({ params: { id: trackA }, body: { versionIds: [versionA2, versionA] } }),
  ],
  [
    "version offset",
    updateTrackVersion,
    () => ({ params: { id: versionA }, body: { offsetSamples: 480 } }),
  ],
  ["version gain", updateTrackVersion, () => ({ params: { id: versionA }, body: { gainDb: -2 } })],
  [
    "version label",
    updateTrackVersion,
    () => ({ params: { id: versionA }, body: { label: "take" } }),
  ],
  ["delete version", deleteTrackVersion, () => ({ params: { id: versionA2 } })],
  ["retry version", retryTrackVersion, () => ({ params: { id: versionA2 } })],
  [
    "create marker",
    createMarker,
    () => ({
      params: { id: songId },
      body: { type: "marker", name: "B", color: "red", startSec: 2 },
    }),
  ],
  ["update marker", updateMarker, () => ({ params: { id: markerId }, body: { name: "A2" } })],
  ["delete marker", deleteMarker, () => ({ params: { id: markerId } })],
  ["restore marker", restoreMarker, () => ({ params: { id: markerId } })],
  [
    "convert markers",
    convertMarkers,
    () => ({ params: { id: songId }, body: { ids: [markerId], to: "section" } }),
  ],
  [
    "put tempo",
    putSongTempo,
    () => ({
      params: { id: songId },
      body: {
        map: { segments: [{ startBeat: 0, bpm: 120, meter: { num: 4, den: 4 } }] },
        bar1OffsetSec: 0,
      },
    }),
  ],
  [
    "import tempo",
    importSongTempoMidi,
    () => ({ params: { id: songId }, body: { fileName: "t.mid", data: "TVRoZA==", markers: [] } }),
  ],
  ["restore tempo", restoreTempoRevision, () => ({ params: { id: songId, revisionId: "x" } })],
  ["delete tempo", deleteSongTempo, () => ({ params: { id: songId } })],
  ["create comment", createComment, () => ({ params: { id: songId }, body: { body: "Yo" } })],
  ["edit comment", updateComment, () => ({ params: { id: commentId }, body: { body: "Hey" } })],
  ["delete comment", deleteComment, () => ({ params: { id: commentId } })],
  ["restore comment", restoreComment, () => ({ params: { id: commentId } })],
  [
    "resolve comment",
    resolveComment,
    () => ({ params: { id: commentId }, body: { resolved: true } }),
  ],
  [
    "react",
    setCommentReaction,
    () => ({ params: { id: commentId }, body: { emoji: "👍", active: true } }),
  ],
  ["batch delete", batchDelete, () => ({ body: { tracks: [trackB] } })],
  ["batch restore", batchRestore, () => ({ body: { tracks: [trashedTrack] } })],
  ["batch purge", batchPurge, () => ({ body: { tracks: [trashedTrack] } })],
  ["batch remove lossless", batchRemoveLossless, () => ({ body: { versions: [versionA] } })],
  [
    "make multitrack (moves)",
    batchMakeMultitrack,
    () => ({ body: { tracks: [trackB], name: "New", targetProjectId: projectId } }),
  ],
  [
    "move song",
    batchMoveSongs,
    () => ({ body: { songs: [songId], targetProjectId: otherProjectId } }),
  ],
  // Last: these take the song away.
  ["delete song", deleteSong, () => ({ params: { id: songId } })],
];

/** Changes that stay allowed while editing: personal state, playback, links, copies. */
const ALLOWED: [string, ContractDef, () => Record<string, unknown>][] = [
  [
    "personal mixer",
    putSongMixer,
    () => ({ params: { id: songId }, body: { state: { tracks: {} } } }),
  ],
  [
    "snapshot",
    createMixerSnapshot,
    () => ({ params: { id: songId }, body: { name: "Mine", state: { tracks: {} } } }),
  ],
  ["visit", recordSongVisit, () => ({ params: { id: songId } })],
  ["follow", setSongFollow, () => ({ params: { id: songId }, body: { following: true } })],
  [
    "offline",
    recordSongOffline,
    () => ({ params: { id: songId }, body: { action: "added", bytes: 1, quality: "normal" } }),
  ],
  [
    "copy tracks",
    batchCopyTracks,
    () => ({ body: { tracks: [trackA], name: "Copy", targetProjectId: otherProjectId } }),
  ],
  ["read tracks", listSongTracks, () => ({ params: { id: songId } })],
];

describe("the edit lock (SPEC §24.7)", () => {
  let id = "";
  let linkToken = "";

  beforeAll(async () => {
    const link = await call(
      t,
      createSongLink,
      {
        params: { id: songId },
        body: {
          scopeType: "song",
          label: "Fans",
          versions: "current-only",
          expiresAt: null,
          allowDownload: false,
          allowComments: true,
          showComments: true,
        },
      },
      eda,
    );
    linkToken = link.json<{ link: { url: string } }>().link.url.split("/l/")[1] ?? "";
    id = sessionOf(await start()).id;
  });

  /** Routes editors may not call anyway (song.delete, trash.purge, lossless.remove). */
  const MANAGERS_ONLY = new Set([
    "delete song",
    "batch purge",
    "batch remove lossless",
    "move song",
  ]);

  it.each(FROZEN)("refuses for everyone, admins included: %s", async (name, contract, input) => {
    const callers = MANAGERS_ONLY.has(name) ? [mara, admin] : [eda, jana, mara, admin];
    for (const cookie of callers) {
      const res = await call(t, contract, input(), cookie);
      expect(codeOf(res)).toBe("SONG_EDITING");
      expect(res.statusCode).toBe(409);
    }
  });

  it("checks capabilities before the lock", async () => {
    const res = await call(
      t,
      putSongTempo,
      FROZEN.find(([n]) => n === "put tempo")?.[2]() ?? {},
      petr,
    );
    expect(codeOf(res)).toBe("FORBIDDEN");
  });

  it("refuses uploads and takes to the song", async () => {
    const data = Buffer.alloc(100);
    for (const target of [
      { type: "newTrack", songId, name: "Keys" },
      { type: "newVersion", trackId: trackA },
      { type: "newTrack", songId, name: "Take", source: "recording" },
    ]) {
      const res = await tusUpload(t, admin, data, "x.wav", target);
      expect(res.createStatus).toBe(409);
      expect(ApiErrorSchema.parse(JSON.parse(res.body)).code).toBe("SONG_EDITING");
    }
  });

  it.each(ALLOWED)("still allows: %s", async (_name, contract, input) => {
    expect(codeOf(await call(t, contract, input(), jana))).toBe("ok");
  });

  it("still allows the session's own routes", async () => {
    const s = sessionOf(await read());
    expect(codeOf(await save(id, { rev: s.rev ?? 0, ops: [split(SEC)] }))).toBe("ok");
  });

  it("shows link visitors the lock without a name and freezes their comments", async () => {
    const open = await visit(linkToken, "POST", "/open");
    const cookie = open.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const song = (await visit(linkToken, "GET", `/songs/${songId}`, cookie)).json<{ song: Song }>()
      .song;
    expect(song.editing).toEqual({
      sessionId: null,
      status: "open",
      since: expect.any(Number) as number,
      by: { id: null, name: null },
    });
    expect(codeOf(await visit(linkToken, "PUT", "/visitor", cookie, { name: "Fan" }))).toBe("ok");
    const comment = await visit(linkToken, "POST", `/songs/${songId}/comments`, cookie, {
      body: "Nice",
    });
    expect(codeOf(comment)).toBe("SONG_EDITING");
    expect(sessionOf(await read(petr)).base).toBeUndefined();
  });

  it("releases everything on cancel", async () => {
    expect(codeOf(await cancel(id))).toBe("ok");
    const res = await tusUpload(t, admin, Buffer.alloc(100), "x.wav", {
      type: "newVersion",
      trackId: trackA,
    });
    expect(res.createStatus).toBe(201);
    expect(
      codeOf(await call(t, updateTrack, { params: { id: trackA }, body: { name: "G" } }, jana)),
    ).toBe("ok");
    expect(
      codeOf(
        await call(t, createComment, { params: { id: songId }, body: { body: "Back" } }, petr),
      ),
    ).toBe("ok");
    // Every other frozen route passes the lock again (deleting the song last).
    for (const [name, contract, input] of FROZEN) {
      const res = await call(t, contract, input(), admin);
      expect([name, codeOf(res)]).not.toEqual([name, "SONG_EDITING"]);
    }
  });
});

describe("permission matrix (SPEC §24.12)", () => {
  const songs = new Map<ContentRole, string>();
  const cookies = new Map<ContentRole, string>();
  const sessions = new Map<ContentRole, string>();

  beforeAll(async () => {
    const matrixProject = (await call(t, createProject, { body: { name: "Matrix" } }, admin)).json<{
      project: { id: string };
    }>().project.id;
    for (const role of CONTENT_ROLES) {
      const u = await seedUser(t, `m${role}`, "member");
      setProjectGrantRow(t.db, matrixProject, u.id, role, bossId);
      cookies.set(role, await loginAs(t, `m${role}`));
      const song = createSongRow(t.db, {
        projectId: matrixProject,
        title: `S ${role}`,
        createdBy: edaId,
      }).id;
      track(song, "Drums", edaId);
      songs.set(role, song);
      sessions.set(role, sessionOf(await start(admin, song)).id);
    }
  });

  const expected = (role: ContentRole, capability: "view" | "audio.edit") =>
    role === "none" ? "NOT_FOUND" : hasCapability(role, capability) ? "allowed" : "FORBIDDEN";
  const outcome = (res: LightMyRequestResponse) => {
    const code = codeOf(res);
    return ["NOT_FOUND", "FORBIDDEN", "UNAUTHENTICATED"].includes(code) ? code : "allowed";
  };

  for (const role of CONTENT_ROLES) {
    it(`${role}: get ${expected(role, "view")}, start/save/take over/cancel ${expected(role, "audio.edit")}`, async () => {
      const cookie = cookies.get(role) ?? "";
      const song = songs.get(role) ?? "";
      const session = sessions.get(role) ?? "";
      expect(outcome(await read(cookie, song))).toBe(expected(role, "view"));
      const edit = expected(role, "audio.edit");
      const startRes = await start(cookie, song);
      expect(outcome(startRes)).toBe(edit);
      if (edit === "allowed") expect(codeOf(startRes)).toBe("EDIT_SESSION_OPEN");
      const saveRes = await save(session, { rev: 0, ops: [] }, cookie);
      expect(outcome(saveRes)).toBe(edit);
      if (edit === "allowed") expect(codeOf(saveRes)).toBe("NOT_SESSION_OWNER");
      expect(outcome(await takeOver(session, cookie))).toBe(edit);
      expect(outcome(await cancel(session, cookie))).toBe(edit);
    });
  }

  it("answers NOT_FOUND for unknown sessions", async () => {
    expect(codeOf(await takeOver("nope", admin))).toBe("NOT_FOUND");
  });
});
