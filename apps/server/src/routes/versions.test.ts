import fs from "node:fs/promises";
import { generateFixtures, matrix, TONE_FILE } from "@bandroom/fixtures";
import { listEvents } from "@bandroom/server-core";
import {
  ApiErrorSchema,
  createProject,
  createSong,
  deleteTrack,
  deleteTrackVersion,
  getProjectQueue,
  listSongTracks,
  listTrackVersions,
  QueueItemSchema,
  reorderSongTracks,
  reorderTrackVersions,
  setCurrentTrackVersion,
  setProjectGrant,
  StackVersionSchema,
  TrackSchema,
  updateTrack,
  updateTrackVersion,
  UploadResultSchema,
} from "@bandroom/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  call,
  createTestApp,
  loginAs,
  runQueuedJobs,
  seedUser,
  tusUpload,
  type TestApp,
} from "../testing/testApp";

let t: TestApp;
let admin: string;
let member: string;
let memberId: string;
let projectId: string;
let songId: string;
let trackId: string;

const versionsOf = async (cookie: string) =>
  z
    .object({ versions: z.array(StackVersionSchema) })
    .parse((await call(t, listTrackVersions, { params: { id: trackId } }, cookie)).json()).versions;
const tracksOf = async (cookie: string) =>
  z
    .object({ tracks: z.array(TrackSchema) })
    .parse((await call(t, listSongTracks, { params: { id: songId } }, cookie)).json()).tracks;
/** No automatic mix any more (SPEC §27): nothing schedules `audio.mixdown`. */
const mixdownJobs = () =>
  t.db.$client.prepare("SELECT id FROM jobs WHERE type = 'audio.mixdown'").all();

/** Runs every queued job now. */
async function runAllJobsNow() {
  for (let pass = 0; pass < 3; pass++) {
    t.db.$client.prepare("UPDATE jobs SET run_after = 0 WHERE status = 'queued'").run();
    if ((await runQueuedJobs(t)).length === 0) return;
  }
}

beforeAll(async () => {
  await generateFixtures();
  t = await createTestApp();
  await seedUser(t, "boss", "admin");
  memberId = (await seedUser(t, "petr", "member")).id;
  admin = await loginAs(t, "boss");
  member = await loginAs(t, "petr");
  projectId = (await call(t, createProject, { body: { name: "Album" } }, admin)).json<{
    project: { id: string };
  }>().project.id;
  songId = (
    await call(t, createSong, { params: { id: projectId }, body: { title: "Song" } }, admin)
  ).json<{ song: { id: string } }>().song.id;
  const tone = await fs.readFile(TONE_FILE());
  const up = await tusUpload(t, member, tone, "Bass.wav", {
    type: "newTrack",
    songId,
    name: "Bass",
  });
  trackId = UploadResultSchema.parse(JSON.parse(up.body)).trackId ?? "";
  const imp = matrix().find((x) => x.name === "imp_48000_s16_mono");
  await tusUpload(t, member, await fs.readFile(imp?.file ?? ""), "bass2.wav", {
    type: "newVersion",
    trackId,
  });
  await tusUpload(t, admin, tone, "Drums.wav", { type: "newTrack", songId, name: "Drums" });
  await runAllJobsNow();
}, 120_000);
afterAll(async () => {
  await t.close();
});

describe("version stack (SPEC §11.3)", () => {
  it("lists versions newest first with the current one marked", async () => {
    const v = await versionsOf(member);
    expect(v.map((x) => [x.number, x.isCurrent, x.status])).toEqual([
      [2, true, "ready"],
      [1, false, "ready"],
    ]);
  });

  it("labels versions (uploader), makes an older one current (editor only) and logs it", async () => {
    const [v2, v1] = await versionsOf(member);
    expect(
      (
        await call(
          t,
          updateTrackVersion,
          { params: { id: v1?.id ?? "" }, body: { label: "first take", notes: "rough" } },
          member,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      ApiErrorSchema.parse(
        (
          await call(
            t,
            setCurrentTrackVersion,
            { params: { id: trackId }, body: { versionId: v1?.id ?? "" } },
            member,
          )
        ).json(),
      ).code,
    ).toBe("FORBIDDEN");
    await call(
      t,
      setProjectGrant,
      { params: { id: projectId, userId: memberId }, body: { role: "editor" } },
      admin,
    );
    expect(
      (
        await call(
          t,
          setCurrentTrackVersion,
          { params: { id: trackId }, body: { versionId: v1?.id ?? "" } },
          member,
        )
      ).statusCode,
    ).toBe(200);
    const after = await versionsOf(member);
    expect(after.find((x) => x.isCurrent)?.number).toBe(1);
    expect(after.find((x) => x.number === 1)).toMatchObject({
      label: "first take",
      notes: "rough",
    });
    expect(listEvents(t.db, { action: "version.set_current" })).toHaveLength(1);
    expect(mixdownJobs()).toEqual([]);
    expect(v2?.number).toBe(2);
  });

  it("reorders the stack without changing version numbers", async () => {
    const [top, second] = await versionsOf(member);
    await call(
      t,
      reorderTrackVersions,
      { params: { id: trackId }, body: { versionIds: [second?.id ?? "", top?.id ?? ""] } },
      member,
    );
    expect((await versionsOf(member)).map((x) => x.number)).toEqual([1, 2]);
    expect(
      listEvents(t.db, { action: "versions.reordered" }).filter((e) => e.targetId === trackId),
    ).toHaveLength(1);
  });

  it("deleting the current version falls back to the newest remaining one", async () => {
    const v1 = (await versionsOf(member)).find((x) => x.number === 1);
    expect(
      (await call(t, deleteTrackVersion, { params: { id: v1?.id ?? "" } }, member)).statusCode,
    ).toBe(200);
    const left = await versionsOf(member);
    expect(left.map((x) => [x.number, x.isCurrent])).toEqual([[2, true]]);
    expect((await tracksOf(member)).find((x) => x.id === trackId)?.versionCount).toBe(1);
  });
});

describe("tracks", () => {
  it("renames, recolors and reorders tracks; default gain changes schedule nothing", async () => {
    await call(
      t,
      updateTrack,
      { params: { id: trackId }, body: { name: "Bass DI", color: "green", instrumentTag: "bass" } },
      member,
    );
    await call(t, updateTrack, { params: { id: trackId }, body: { defaultGainDb: -3 } }, member);
    expect(mixdownJobs()).toEqual([]);
    const drums = (await tracksOf(member)).find((x) => x.name === "Drums");
    await call(
      t,
      reorderSongTracks,
      { params: { id: songId }, body: { trackIds: [drums?.id ?? "", trackId] } },
      member,
    );
    expect((await tracksOf(member)).map((x) => [x.name, x.color])).toEqual([
      ["Drums", "red"],
      ["Bass DI", "green"],
    ]);
  });

  it("colours new tracks by instrument, else with a colour the song does not use (§25.10)", async () => {
    const project = (await call(t, createProject, { body: { name: "Colours" } }, admin)).json<{
      project: { id: string };
    }>().project.id;
    const other = (
      await call(t, createSong, { params: { id: project }, body: { title: "Colours" } }, admin)
    ).json<{ song: { id: string } }>().song.id;
    const tone = await fs.readFile(TONE_FILE());
    for (const name of ["Take", "Bass", "Other take", "Vocals"])
      await tusUpload(t, admin, tone, `${name}.wav`, { type: "newTrack", songId: other, name });
    const res = await call(t, listSongTracks, { params: { id: other } }, admin);
    const tracks = z.object({ tracks: z.array(TrackSchema) }).parse(res.json()).tracks;
    expect(tracks.map((x) => [x.name, x.color])).toEqual([
      ["Take", "red"],
      ["Bass", "orange"],
      ["Other take", "yellow"],
      ["Vocals", "violet"],
    ]);
  });

  it("rolls the change back when its event cannot be written (review M14)", async () => {
    t.db.$client.exec(`CREATE TEMP TRIGGER no_track_events BEFORE INSERT ON events
      WHEN NEW.action IN ('track.updated', 'track.deleted')
      BEGIN SELECT RAISE(ABORT, 'event log unavailable'); END`);
    try {
      const rename = await call(
        t,
        updateTrack,
        { params: { id: trackId }, body: { name: "Renamed" } },
        member,
      );
      expect(rename.statusCode).toBe(500);
      expect((await call(t, deleteTrack, { params: { id: trackId } }, admin)).statusCode).toBe(500);
      expect((await tracksOf(member)).map((x) => x.name)).toEqual(["Drums", "Bass DI"]);
    } finally {
      t.db.$client.exec("DROP TRIGGER no_track_events");
    }
  });
});

describe("version gain (SPEC §25.6)", () => {
  it("follows the track's edit rule and logs before/after", async () => {
    await seedUser(t, "eva", "member");
    const eva = await loginAs(t, "eva");
    const drums = (await tracksOf(admin)).find((x) => x.name === "Drums");
    const current = drums?.current?.id ?? "";
    expect(drums?.current?.gainDb).toBe(0);
    const patch = (cookie: string, id: string, body: Record<string, unknown>) =>
      call(t, updateTrackVersion, { params: { id }, body }, cookie);

    // A contributor uploads a version of someone else's track: label yes, gain no.
    const up = await tusUpload(t, eva, await fs.readFile(TONE_FILE()), "drums2.wav", {
      type: "newVersion",
      trackId: drums?.id ?? "",
    });
    const evaVersion = UploadResultSchema.parse(JSON.parse(up.body)).trackVersionId ?? "";
    expect((await patch(eva, evaVersion, { label: "mine" })).statusCode).toBe(200);
    const denied = await patch(eva, evaVersion, { gainDb: 3 });
    expect(ApiErrorSchema.parse(denied.json()).code).toBe("FORBIDDEN");
    expect((await patch(eva, current, { gainDb: 3 })).statusCode).toBe(403);
    // Not a finite number.
    expect((await patch(admin, current, { gainDb: "loud" })).statusCode).toBe(400);
    expect((await patch(admin, current, { gainDb: null })).statusCode).toBe(400);

    // The track's creator (here an admin) sets any finite value.
    await call(
      t,
      setCurrentTrackVersion,
      {
        params: { id: drums?.id ?? "" },
        body: { versionId: current },
      },
      admin,
    );
    expect((await patch(admin, current, { gainDb: 37.5 })).statusCode).toBe(200);
    expect(mixdownJobs()).toEqual([]);
    expect((await tracksOf(eva)).find((x) => x.name === "Drums")?.current?.gainDb).toBe(37.5);
    expect((await patch(admin, current, { gainDb: -4 })).statusCode).toBe(200);
    // The same value again changes nothing and logs nothing.
    expect((await patch(admin, current, { gainDb: -4 })).statusCode).toBe(200);
    const events = listEvents(t.db, { action: "version.gain_changed" }).filter(
      (e) => e.targetId === current,
    );
    expect(events.map((e) => JSON.parse(e.details ?? "null") as unknown)).toEqual([
      { trackId: drums?.id, before: 0, after: 37.5 },
      { trackId: drums?.id, before: 37.5, after: -4 },
    ]);
    // A label change alone is not a gain change.
    expect(
      listEvents(t.db, { action: "version.updated" }).filter((e) => e.targetId === evaVersion),
    ).toHaveLength(1);
  });
});

describe("play queue (SPEC §6.10, §27)", () => {
  it("has no Listen source any more", async () => {
    await runAllJobsNow();
    const res = await t.app.inject({
      url: `/api/v1/songs/${songId}/listen`,
      headers: { cookie: member },
    });
    expect(res.statusCode).toBe(404);
    expect(mixdownJobs()).toEqual([]);
  }, 120_000);

  it("returns the project queue in song order with a ready flag", async () => {
    const empty = (
      await call(
        t,
        createSong,
        { params: { id: projectId }, body: { title: "No audio yet" } },
        admin,
      )
    ).json<{ song: { id: string } }>().song.id;
    const items = z
      .object({ items: z.array(QueueItemSchema) })
      .parse((await call(t, getProjectQueue, { params: { id: projectId } }, member)).json()).items;
    expect(items.map((i) => [i.title, i.ready])).toEqual([
      ["Song", true],
      ["No audio yet", false],
    ]);
    expect(items[1]?.songId).toBe(empty);
  });
});
