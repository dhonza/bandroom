import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { matrix, MP3_FILE } from "@bandroom/fixtures";
import {
  claimJob,
  DEFAULT_TOOLS,
  ffmpegArgs,
  getBlob,
  getVariant,
  listEvents,
  LocalStorage,
  recoverExpiredJobs,
  removeVariant,
  runTool,
  schema,
  setProjectGrantRow,
  setSongGrantRow,
  updateUser,
  LEASE_MS,
} from "@bandroom/server-core";
import {
  ApiErrorSchema,
  applyEditSession,
  batchRestore,
  bounceEditSession,
  cancelEditSession,
  createComment,
  createMarker,
  createSong,
  DEFAULT_EDIT_FADES,
  EditReviewSchema,
  EditSessionSchema,
  FOLLOW_ALL,
  getEditSession,
  listSongComments,
  listSongMarkers,
  listProjectSongs,
  listSongTracks,
  listTrackVersions,
  putSongTempo,
  retryEditSession,
  reviewEditSession,
  saveEditSession,
  startEditSession,
  TrackSchema,
  uuidv7,
  type EditOp,
  type EditSession,
  type Marker,
  type Track,
} from "@bandroom/shared";
import { and, eq, isNotNull } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { call, loginAs, runQueuedJobs, seedUser, tusUpload } from "../testing/testApp";
import { admin, projectId, setupUploadFixtures, t } from "../testing/uploadFixtures";

/**
 * Apply & Bounce (SPEC §24.8–§24.10, §24.14, §24.17 worker + API): real uploads, renders and
 * ingests with ffmpeg.
 */

setupUploadFixtures();

const SEC = 48_000;
let eda: string; // editor on the project
let edaId: string;
let sona: string; // editor on one song only (no song.create on the project)
let sonaId: string;

const fixture = (name: string) => {
  const f = matrix().find((x) => x.name === name);
  if (!f) throw new Error(`fixture ${name}`);
  return f.file;
};

const codeOf = (res: LightMyRequestResponse) =>
  res.statusCode >= 400 ? ApiErrorSchema.parse(res.json()).code : "ok";
const sessionOf = (res: LightMyRequestResponse): EditSession =>
  EditSessionSchema.parse(res.json<{ session: unknown }>().session);

async function tracksOf(songId: string, cookie = eda): Promise<Track[]> {
  return z
    .object({ tracks: z.array(TrackSchema) })
    .parse((await call(t, listSongTracks, { params: { id: songId } }, cookie)).json()).tracks;
}

/** A song with uploaded, processed tracks. */
async function songWith(title: string, files: [string, string][]): Promise<string> {
  const id = (
    await call(t, createSong, { params: { id: projectId }, body: { title } }, admin)
  ).json<{ song: { id: string } }>().song.id;
  for (const [name, file] of files) {
    const up = await tusUpload(t, admin, await fs.readFile(file), `${name}.wav`, {
      type: "newTrack",
      songId: id,
      name,
    });
    expect(up.status).toBe(200);
  }
  await runQueuedJobs(t);
  return id;
}

function op(partial: Partial<EditOp> & Pick<EditOp, "type">): EditOp {
  return {
    id: uuidv7(),
    at: Date.now(),
    userId: edaId,
    timeline: FOLLOW_ALL,
    ...partial,
  } as EditOp;
}
const cut = (start: number, end: number, tracks: string[]) =>
  op({ type: "cut", range: { start, end }, tracks, fades: DEFAULT_EDIT_FADES });

async function startWith(songId: string, ops: (ids: string[]) => EditOp[]): Promise<EditSession> {
  const started = sessionOf(await call(t, startEditSession, { params: { id: songId } }, eda));
  const ids = started.base?.tracks.map((x) => x.trackId) ?? [];
  const list = ops(ids);
  const res = await call(
    t,
    saveEditSession,
    {
      params: { id: started.id },
      body: {
        rev: started.rev ?? 0,
        ops: list,
        cursor: list.length,
        options: { fades: DEFAULT_EDIT_FADES, overlap: "mix", timeline: FOLLOW_ALL, snap: "off" },
      },
    },
    eda,
  );
  expect(res.statusCode).toBe(200);
  return sessionOf(res);
}

const review = async (id: string, query: Record<string, string>, cookie = eda) => {
  const res = await call(t, reviewEditSession, { params: { id }, query }, cookie);
  expect(res.statusCode).toBe(200);
  return EditReviewSchema.parse(res.json<{ review: unknown }>().review);
};

const apply = (s: EditSession, requestId = uuidv7(), cookie = eda) =>
  call(t, applyEditSession, { params: { id: s.id }, body: { requestId, rev: s.rev ?? 0 } }, cookie);

const bounce = (s: EditSession, body: Record<string, unknown>, cookie = eda) =>
  call(
    t,
    bounceEditSession,
    { params: { id: s.id }, body: { requestId: uuidv7(), rev: s.rev ?? 0, ...body } },
    cookie,
  );

const detailsOf = (e: { details: unknown }): Record<string, unknown> =>
  (typeof e.details === "string" ? JSON.parse(e.details) : (e.details ?? {})) as Record<
    string,
    unknown
  >;
const songEvents = (songId: string) => listEvents(t.db, {}).filter((e) => e.songId === songId);
const sessionRow = (id: string) =>
  t.db.select().from(schema.editSessions).where(eq(schema.editSessions.id, id)).get();
const hiddenVersions = () =>
  t.db
    .select()
    .from(schema.trackVersions)
    .where(isNotNull(schema.trackVersions.editSessionId))
    .all();

/** Mono samples of a stored variant decoded at 48 kHz. */
async function decode(assetId: string, variant: string): Promise<Float32Array> {
  const v = getVariant(t.db, assetId, variant);
  const blob = v && getBlob(t.db, v.blobHash);
  if (!blob) throw new Error(`no ${variant}`);
  const file = await new LocalStorage(path.join(t.dataDir, "blobs")).localPath(blob.storageKey);
  const chunks: Buffer[] = [];
  await runTool(
    DEFAULT_TOOLS.ffmpeg,
    ffmpegArgs("-i", file, "-af", "pan=mono|c0=c0", "-ar", "48000", "-f", "f32le", "-"),
    {
      stdout: async (out: Readable) => {
        for await (const c of out) chunks.push(c as Buffer);
      },
    },
  );
  const buf = Buffer.concat(chunks);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function peakNear(pcm: Float32Array, frame: number, window = 600): number {
  let best = -1;
  let at = -1;
  for (let i = Math.max(0, frame - window); i < Math.min(pcm.length, frame + window); i++) {
    const v = Math.abs(pcm[i] ?? 0);
    if (v > best) {
      best = v;
      at = i;
    }
  }
  return at;
}

const assetOfVersion = (versionId: string) =>
  t.db
    .select({ a: schema.trackVersions.assetId })
    .from(schema.trackVersions)
    .where(eq(schema.trackVersions.id, versionId))
    .get()?.a ?? "";

beforeAll(async () => {
  const e = await seedUser(t, "eda", "member");
  edaId = e.id;
  setProjectGrantRow(t.db, projectId, edaId, "editor", edaId);
  eda = await loginAs(t, "eda");
  const s = await seedUser(t, "sona", "member");
  sonaId = s.id;
  sona = await loginAs(t, "sona");
}, 60_000);

describe("Apply (SPEC §24.8)", () => {
  let songId = "";
  let session: EditSession;
  let before: Track[] = [];
  let markerId = "";
  const requestId = uuidv7();

  it(
    "reviews an apply on 4 tracks: outputs, sizes, warnings and the timeline follow-up",
    { timeout: 240_000 },
    async () => {
      songId = await songWith("Apply", [
        ["Mono48", fixture("imp_48000_s24_mono")],
        ["Stereo44", fixture("imp_44100_s16_stereo")],
        ["Dual96", fixture("imp_96000_f32_dualmono")],
        ["Lossy", MP3_FILE()],
      ]);
      before = await tracksOf(songId);
      expect(before.map((x) => x.current?.status)).toEqual(["ready", "ready", "ready", "ready"]);
      markerId = (
        await call(
          t,
          createMarker,
          {
            params: { id: songId },
            body: { type: "marker", name: "M", color: "red", startSec: 4 },
          },
          admin,
        )
      ).json<{ marker: { id: string } }>().marker.id;
      await call(
        t,
        createMarker,
        {
          params: { id: songId },
          body: { type: "marker", name: "Gone", color: "red", startSec: 1.5 },
        },
        admin,
      );
      await call(
        t,
        createComment,
        { params: { id: songId }, body: { body: "At four", startSec: 4 } },
        admin,
      );
      await call(
        t,
        putSongTempo,
        {
          params: { id: songId },
          body: {
            map: { segments: [{ startBeat: 0, bpm: 120, meter: { num: 4, den: 4 } }] },
            bar1OffsetSec: 0,
          },
        },
        admin,
      );
      // Cut [1 s, 2 s) on all tracks: everything after 2 s moves 1 s left.
      session = await startWith(songId, (ids) => [cut(SEC, 2 * SEC, ids)]);
      const r = await review(session.id, { kind: "apply" });
      expect(r.rev).toBe(session.rev);
      expect(r.outputs).toHaveLength(4);
      expect(r.outputs.map((o) => o.title)).toEqual(["Mono48", "Stereo44", "Dual96", "Lossy"]);
      const mono = r.outputs[0];
      expect(mono?.oldDurationSec).toBeCloseTo(6, 3);
      expect(mono?.durationSec).toBeCloseTo(5, 3);
      expect(mono?.estimatedBytes).toBe(5 * SEC * 3 + 44);
      expect(r.totalBytes).toBeGreaterThan(0);
      expect(r.fitsQuota).toBe(true);
      expect(r.warnings.map((w) => w.code)).toContain("LOSSY_SOURCE");
      expect(r.warnings.find((w) => w.code === "LOSSY_SOURCE")?.trackIds).toEqual([before[3]?.id]);
      expect(r.remap).toMatchObject({
        markersMoved: 1,
        markersDeleted: 1,
        commentsMoved: 1,
        commentsEditedOut: 0,
        // The join at 1 s is mid-bar (120 bpm, 4/4): a new segment starts there.
        tempoChanged: true,
        tempoSegmentsBefore: 1,
      });
      expect(r.remap?.tempoSegmentsAfter).toBeGreaterThan(1);
      expect(r.estimatedSec).toBeGreaterThan(0);
      expect(r.ranges).toEqual({ sections: [], markers: [] });
    },
  );

  it("applies: the session is applying, nothing visible changes, a replay answers the same", async () => {
    const res = await apply(session, requestId);
    expect(res.statusCode).toBe(200);
    const s = sessionOf(res);
    expect(s.status).toBe("applying");
    expect(s.outcome).toMatchObject({ kind: "apply", by: edaId });
    expect(s.renders).toHaveLength(4);
    expect(s.renders?.every((r) => r.status === "queued" && r.phase === "render")).toBe(true);
    const again = await apply(session, requestId);
    expect(again.statusCode).toBe(200);
    expect(sessionOf(again).status).toBe("applying");
    expect(
      t.db
        .select()
        .from(schema.editRenders)
        .all()
        .filter((r) => r.sessionId === s.id),
    ).toHaveLength(4);
    // Hidden versions: in the database, not in any list.
    expect(hiddenVersions()).toHaveLength(4);
    const now = await tracksOf(songId);
    expect(now.map((x) => [x.current?.id, x.versionCount])).toEqual(
      before.map((x) => [x.current?.id, x.versionCount]),
    );
    const stack = await call(t, listTrackVersions, { params: { id: before[0]?.id ?? "" } }, eda);
    expect(stack.json<{ versions: unknown[] }>().versions).toHaveLength(1);
    // A second apply is refused while applying.
    expect(codeOf(await apply({ ...session, rev: s.rev ?? 0 }))).toBe("EDIT_SESSION_STATE");
  });

  it(
    "renders, ingests and commits once: new current versions, old ones in the Trash, remap once",
    { timeout: 240_000 },
    async () => {
      const rev = t.db
        .select({ r: schema.songs.timelineRev })
        .from(schema.songs)
        .where(eq(schema.songs.id, songId))
        .get()?.r;
      await runQueuedJobs(t);
      const row = sessionRow(session.id);
      expect(row?.status).toBe("done");
      expect(hiddenVersions()).toHaveLength(0);
      const after = await tracksOf(songId);
      after.forEach((x, i) => {
        const was = before[i];
        expect(x.current?.id).not.toBe(was?.current?.id);
        expect(x.current?.status).toBe("ready");
        expect(x.current?.source).toBe("edit");
        expect(x.current?.number).toBe((was?.current?.number ?? 0) + 1);
        expect(x.current?.label).toBe(was?.current?.label);
        expect(x.versionCount).toBe(1);
      });
      // The lossy source keeps its badge through the FLAC render.
      expect(after[3]?.current?.media?.lossless).toBe(false);
      expect(after[0]?.current?.media?.lossless).toBe(true);
      // Impulses at 0.5, 3, 5.5 s → 0.5, 2, 4.5 s: exact for 48 kHz, ±1 for other rates.
      for (const [i, tol] of [
        [0, 0],
        [1, 1],
        [2, 1],
      ] as const) {
        const pcm = await decode(assetOfVersion(after[i]?.current?.id ?? ""), "flac");
        for (const at of [0.5 * SEC, 2 * SEC, 4.5 * SEC])
          expect(Math.abs(peakNear(pcm, at) - at)).toBeLessThanOrEqual(tol);
      }
      // Markers, comments: moved once; the one inside the cut is deleted.
      const markers = (await call(t, listSongMarkers, { params: { id: songId } }, eda)).json<{
        markers: Marker[];
      }>().markers;
      expect(markers.map((m) => [m.id, m.startSec])).toEqual([[markerId, 3]]);
      expect(
        t.db
          .select({ r: schema.songs.timelineRev })
          .from(schema.songs)
          .where(eq(schema.songs.id, songId))
          .get()?.r,
      ).toBe((rev ?? 0) + 1);
      const events = songEvents(songId).map((e) => e.action);
      expect(events.filter((a) => a === "edit.applied")).toHaveLength(1);
      expect(events.filter((a) => a === "timeline.remapped")).toHaveLength(1);
      expect(events.filter((a) => a === "version.rendered")).toHaveLength(4);
      expect(events).toContain("edit.render_requested");
      const deleted = songEvents(songId).filter((e) => e.action === "version.deleted");
      expect(deleted).toHaveLength(4);
      expect(deleted.every((e) => detailsOf(e).reason === "edit")).toBe(true);
      // The edit lock is released.
      const active = await call(t, getEditSession, { params: { id: songId } }, eda);
      expect(active.json<{ session: unknown }>().session).toBeNull();
    },
  );

  it("keeps the replaced versions restorable from the Trash", async () => {
    const old = before[0]?.current?.id ?? "";
    const res = await call(t, batchRestore, { body: { versions: [old] } }, admin);
    expect(res.statusCode).toBe(200);
    const stack = await call(t, listTrackVersions, { params: { id: before[0]?.id ?? "" } }, eda);
    expect(stack.json<{ versions: { id: string }[] }>().versions.map((v) => v.id)).toContain(old);
  });
});

describe("Bounce (SPEC §24.9)", () => {
  let songId = "";
  let tracks: Track[] = [];

  beforeAll(async () => {
    songId = await songWith("Rehearsal", [
      ["Guitar", fixture("imp_48000_s16_mono")],
      ["Bass", fixture("imp_48000_s24_stereo")],
    ]);
    tracks = await tracksOf(songId);
    for (const [name, startSec] of [
      ["Intro", 1],
      ["Verse", 3],
    ] as const)
      await call(
        t,
        createMarker,
        { params: { id: songId }, body: { type: "marker", name, color: "blue", startSec } },
        admin,
      );
    await call(
      t,
      createComment,
      { params: { id: songId }, body: { body: "In the verse", startSec: 4 } },
      admin,
    );
  }, 120_000);

  it(
    "to new versions: the edit becomes current as 'Edit of v1', the old one stays",
    { timeout: 120_000 },
    async () => {
      const s = await startWith(songId, (ids) => [cut(0.25 * SEC, 0.4 * SEC, [ids[0] ?? ""])]);
      const r = await review(s.id, { kind: "bounceVersions" });
      expect(r.outputs.map((o) => o.trackId)).toEqual([tracks[0]?.id]);
      expect(r.warnings.map((w) => w.code)).toContain("OUT_OF_SYNC");
      expect(r.remap).toBeNull(); // a subset ripple moves no markers
      expect((await bounce(s, { kind: "bounceVersions" })).statusCode).toBe(200);
      await runQueuedJobs(t);
      expect(sessionRow(s.id)?.status).toBe("done");
      const now = await tracksOf(songId);
      expect(now[0]?.current?.label).toBe("Edit of v1");
      expect(now[0]?.current?.number).toBe(2);
      expect(now[0]?.versionCount).toBe(2);
      expect(now[1]?.current?.id).toBe(tracks[1]?.current?.id);
      tracks = now;
    },
  );

  it(
    "to new tracks: '<track> (edit)' appended, the originals stay current",
    { timeout: 120_000 },
    async () => {
      const s = await startWith(songId, (ids) => [cut(0.25 * SEC, 0.4 * SEC, ids)]);
      expect((await bounce(s, { kind: "bounceTracks" })).statusCode).toBe(200);
      await runQueuedJobs(t);
      expect(sessionRow(s.id)?.status).toBe("done");
      const now = await tracksOf(songId);
      expect(now.map((x) => x.name)).toEqual(["Guitar", "Bass", "Guitar (edit)", "Bass (edit)"]);
      expect(now[0]?.current?.id).toBe(tracks[0]?.current?.id);
      expect(now[2]?.color).toBe(now[0]?.color);
      expect(now[2]?.current?.status).toBe("ready");
      // No remap: the markers stay where they were.
      const markers = (await call(t, listSongMarkers, { params: { id: songId } }, eda)).json<{
        markers: Marker[];
      }>().markers;
      expect(markers.map((m) => m.startSec).sort()).toEqual([1, 3]);
    },
  );

  it(
    "into 2 songs at markers with the chosen names; the source song is unchanged",
    { timeout: 180_000 },
    async () => {
      const s = await startWith(songId, (ids) => [cut(0.25 * SEC, 0.4 * SEC, ids.slice(0, 2))]);
      const naming = { title: "sessionAndName", numbered: "true", trackNames: "rangePrefix" };
      const r = await review(s.id, { kind: "bounceSongs", by: "markers", ...naming });
      // Markers at 1 s and 3 s, 0.15 s earlier after the cut on all tracks? No: on 2 of 4.
      expect(r.ranges.markers.map((x) => x.id)).toHaveLength(3);
      expect(r.ranges.markers[0]?.source).toBe("start");
      const picked = r.ranges.markers.slice(1);
      // The range from 0:00 has no name: the session's song title.
      expect(r.outputs[0]?.songTitle).toBe("01 Rehearsal");
      expect(r.outputs.find((o) => o.rangeId === picked[0]?.id)?.songTitle).toBe(
        "02 Rehearsal – Intro",
      );
      expect(
        r.outputs.find((o) => o.trackId === tracks[0]?.id && o.rangeId === picked[0]?.id)?.title,
      ).toBe("Intro – Guitar");
      // Not allowed without song.create on the project.
      setSongGrantRow(t.db, songId, sonaId, "editor", edaId);
      const res = await bounce(
        s,
        {
          kind: "bounceSongs",
          ranges: picked.map((x, i) => ({ ...x, title: i === 0 ? "Opening" : "Second" })),
          naming: { title: "name", numbered: false, trackNames: "rangePrefix" },
          carryTempo: false,
        },
        sona,
      );
      expect(codeOf(res)).toBe("FORBIDDEN");
      const ok = await bounce(s, {
        kind: "bounceSongs",
        ranges: picked.map((x, i) => ({ ...x, title: i === 0 ? "Opening" : "Second" })),
        naming: { title: "name", numbered: false, trackNames: "rangePrefix" },
      });
      expect(ok.statusCode).toBe(200);
      const before = await tracksOf(songId);
      await runQueuedJobs(t);
      expect(sessionRow(s.id)?.status).toBe("done");
      const songs = (await call(t, listProjectSongs, { params: { id: projectId } }, eda)).json<{
        songs: { id: string; title: string }[];
      }>().songs;
      const made = songs.filter((x) => x.title === "Opening" || x.title === "Second");
      expect(made.map((x) => x.title)).toEqual(["Opening", "Second"]);
      // Right after the source song.
      const at = songs.findIndex((x) => x.id === songId);
      expect(songs[at + 1]?.title).toBe("Opening");
      const opening = await tracksOf(made[0]?.id ?? "");
      expect(opening.map((x) => x.name)).toEqual([
        "Intro – Guitar",
        "Intro – Bass",
        "Intro – Guitar (edit)",
        "Intro – Bass (edit)",
      ]);
      expect(opening.every((x) => x.current?.status === "ready")).toBe(true);
      // The verse's comment went along, shifted to the range; its own marker is at 0.
      const second = made[1]?.id ?? "";
      const markers = (await call(t, listSongMarkers, { params: { id: second } }, eda)).json<{
        markers: Marker[];
      }>().markers;
      expect(markers.map((m) => [m.name, m.startSec, m.anchor])).toEqual([["Verse", 0, "time"]]);
      const comments = (await call(t, listSongComments, { params: { id: second } }, eda)).json<{
        comments: { body: string; startSec: number | null }[];
      }>().comments;
      expect(comments.map((c) => [c.body, c.startSec])).toEqual([["In the verse", 1]]);
      // No tempo map unless asked for.
      expect(
        t.db.select().from(schema.tempoMaps).where(eq(schema.tempoMaps.songId, second)).get(),
      ).toBeUndefined();
      // The source song is unchanged.
      expect((await tracksOf(songId)).map((x) => x.current?.id)).toEqual(
        before.map((x) => x.current?.id),
      );
      expect(
        listEvents(t.db, {}).filter((e) => e.action === "song.created" && detailsOf(e).edit),
      ).toHaveLength(2);
      const notes = t.db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.type, "edit_bounced"))
        .all();
      // One notification per bounce, to the project's followers (the admin created it).
      expect(notes).toHaveLength(1);
      expect(JSON.parse(notes[0]?.payload ?? "{}")).toMatchObject({
        count: 2,
        songTitle: "Rehearsal",
      });
    },
  );
});

describe("Failure, retry, cancel, crash (SPEC §24.14)", () => {
  let songId = "";
  let tracks: Track[] = [];

  beforeAll(async () => {
    songId = await songWith("Fail", [["Guitar", fixture("imp_48000_s16_mono")]]);
    tracks = await tracksOf(songId);
  }, 120_000);

  it("refuses when the quota does not fit", async () => {
    const s = await startWith(songId, (ids) => [cut(SEC, 2 * SEC, ids)]);
    updateUser(t.db, edaId, { quotaBytes: 1 });
    const res = await apply(s);
    expect(codeOf(res)).toBe("QUOTA_EXCEEDED");
    updateUser(t.db, edaId, { quotaBytes: null });
    expect(sessionRow(s.id)?.status).toBe("open");
    await call(t, cancelEditSession, { params: { id: s.id } }, eda);
  });

  it(
    "a failed render leaves the song untouched; retry renders and commits",
    { timeout: 120_000 },
    async () => {
      const s = await startWith(songId, (ids) => [cut(SEC, 2 * SEC, ids)]);
      expect((await apply(s)).statusCode).toBe(200);
      // The quota shrinks before the render: the render fails for good.
      updateUser(t.db, edaId, { quotaBytes: 1 });
      await runQueuedJobs(t);
      const failed = sessionOf(await call(t, getEditSession, { params: { id: songId } }, eda));
      expect(failed.status).toBe("open");
      expect(failed.error).toMatch(/QUOTA_EXCEEDED/);
      expect(failed.renders?.[0]?.status).toBe("failed");
      expect((await tracksOf(songId)).map((x) => x.current?.id)).toEqual(
        tracks.map((x) => x.current?.id),
      );
      expect(songEvents(songId).some((e) => e.action === "edit.failed")).toBe(true);
      updateUser(t.db, edaId, { quotaBytes: null });
      const retried = await call(t, retryEditSession, { params: { id: s.id } }, eda);
      expect(retried.statusCode).toBe(200);
      expect(sessionOf(retried).status).toBe("applying");
      await runQueuedJobs(t);
      expect(sessionRow(s.id)?.status).toBe("done");
      const now = await tracksOf(songId);
      expect(now[0]?.current?.source).toBe("edit");
      tracks = now;
    },
  );

  it("cancels while applying: renders skipped, hidden versions and files purged", async () => {
    const s = await startWith(songId, (ids) => [cut(SEC, 2 * SEC, ids)]);
    expect((await apply(s)).statusCode).toBe(200);
    expect(hiddenVersions()).toHaveLength(1);
    const assetId = hiddenVersions()[0]?.assetId ?? "";
    const res = await call(t, cancelEditSession, { params: { id: s.id } }, eda);
    expect(res.statusCode).toBe(200);
    expect(sessionOf(res).status).toBe("cancelled");
    expect(hiddenVersions()).toHaveLength(0);
    expect(
      t.db.select().from(schema.assets).where(eq(schema.assets.id, assetId)).get(),
    ).toBeUndefined();
    expect(
      t.db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.type, "audio.render"), eq(schema.jobs.status, "queued")))
        .all(),
    ).toHaveLength(0);
    await runQueuedJobs(t);
    expect((await tracksOf(songId)).map((x) => x.current?.id)).toEqual(
      tracks.map((x) => x.current?.id),
    );
  });

  it(
    "resumes after a worker crash without duplicates and commits once (Opus source ±1)",
    { timeout: 120_000 },
    async () => {
      // Full quality removed: the render reads the Opus.
      const assetId = assetOfVersion(tracks[0]?.current?.id ?? "");
      removeVariant(t.db, assetId, "flac");
      removeVariant(t.db, assetId, "original");
      const s = await startWith(songId, (ids) => [cut(SEC, 2 * SEC, ids)]);
      const r = await review(s.id, { kind: "apply" });
      expect(r.warnings.map((w) => w.code)).toContain("ARCHIVED_SOURCE");
      expect((await apply(s)).statusCode).toBe(200);
      // The worker claims the render and dies: the lease expires, the job is queued again.
      const job = claimJob(t.db, "dead-worker", ["audio.render"], Date.now());
      expect(job?.type).toBe("audio.render");
      t.db
        .update(schema.jobs)
        .set({ lockedUntil: Date.now() - LEASE_MS })
        .where(eq(schema.jobs.id, job?.id ?? ""))
        .run();
      expect(recoverExpiredJobs(t.db).requeued).toBe(1);
      await runQueuedJobs(t);
      expect(sessionRow(s.id)?.status).toBe("done");
      const now = await tracksOf(songId);
      expect(now[0]?.versionCount).toBe(1);
      expect(songEvents(songId).filter((e) => e.action === "edit.applied")).toHaveLength(2);
      const pcm = await decode(assetOfVersion(now[0]?.current?.id ?? ""), "flac");
      // The impulse at 0.5 s stays in place (±1 for Opus).
      expect(Math.abs(peakNear(pcm, 0.5 * SEC) - 0.5 * SEC)).toBeLessThanOrEqual(1);
      // The new version is lossy-derived (from the Opus).
      expect(now[0]?.current?.media?.lossless).toBe(false);
    },
  );

  it("needs audio.edit and the session's owner", async () => {
    const s = await startWith(songId, (ids) => [cut(SEC, 1.5 * SEC, ids)]);
    expect(codeOf(await apply(s, uuidv7(), admin))).toBe("NOT_SESSION_OWNER");
    setSongGrantRow(t.db, songId, sonaId, "contributor", edaId);
    expect(codeOf(await apply(s, uuidv7(), sona))).toBe("FORBIDDEN");
    expect(codeOf(await apply({ ...s, rev: (s.rev ?? 0) + 5 }))).toBe("EDIT_CONFLICT");
    await call(t, cancelEditSession, { params: { id: s.id } }, eda);
  });
});
