import fs from "node:fs/promises";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { setSongGrantRow } from "@bandroom/server-core";
import {
  batchRemoveLossless,
  createProject,
  createSong,
  getProject,
  getSong,
  listProjects,
  listProjectSongs,
  listSongTracks,
  listTrackVersions,
  type Project,
  type ProjectSummary,
  type Song,
  type SongSummary,
  type Track,
  type TrackVersion,
} from "@bandroom/shared";
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

let t: TestApp;
let admin: string;
let guest: string;
let projectId: string;
let songId: string;

beforeAll(async () => {
  await generateFixtures();
  t = await createTestApp();
  const boss = await seedUser(t, "boss", "admin");
  const g = await seedUser(t, "gita", "guest");
  admin = await loginAs(t, "boss");
  guest = await loginAs(t, "gita");
  projectId = (await call(t, createProject, { body: { name: "Album" } }, admin)).json<{
    project: { id: string };
  }>().project.id;
  songId = (
    await call(t, createSong, { params: { id: projectId }, body: { title: "Song" } }, admin)
  ).json<{ song: { id: string } }>().song.id;
  setSongGrantRow(t.db, songId, g.id, "viewer", boss.id);
}, 60_000);
afterAll(async () => {
  await t.close();
});

const settle = async () => {
  for (let pass = 0; pass < 3; pass++) {
    t.db.$client.prepare("UPDATE jobs SET run_after = 0 WHERE status = 'queued'").run();
    if ((await runQueuedJobs(t)).length === 0) break;
  }
};
const projectBytes = async (cookie = admin) =>
  (await call(t, getProject, { params: { id: projectId } }, cookie)).json<{ project: Project }>()
    .project.bytes;
const libraryBytes = async (cookie = admin) =>
  (await call(t, listProjects, { query: {} }, cookie))
    .json<{ projects: ProjectSummary[] }>()
    .projects.find((p) => p.id === projectId)?.bytes;
const songRowBytes = async () =>
  (await call(t, listProjectSongs, { params: { id: projectId } }, admin))
    .json<{ songs: SongSummary[] }>()
    .songs.find((s) => s.id === songId)?.bytes;
const songBytes = async () =>
  (await call(t, getSong, { params: { id: songId } }, admin)).json<{ song: Song }>().song.bytes;
const tracks = async () =>
  (await call(t, listSongTracks, { params: { id: songId } }, admin)).json<{ tracks: Track[] }>()
    .tracks;

describe("storage sizes (SPEC §28.6)", () => {
  it("starts at zero, grows with uploads and versions, and drops when full quality goes", async () => {
    expect(await projectBytes()).toBe(0);
    expect(await songRowBytes()).toBe(0);

    const tone = await fs.readFile(TONE_FILE());
    await tusUpload(t, admin, tone, "Bass.wav", { type: "newTrack", songId, name: "Bass" });
    await settle();
    const [bass] = await tracks();
    const one = bass?.bytes ?? 0;
    // The stored files (FLAC, Opus, peaks, seek indexes…), not the uploaded size.
    expect(one).toBeGreaterThan(0);
    expect(bass?.current?.storedBytes).toBe(one);
    expect(bass?.current?.sizeBytes).toBe(tone.length);
    expect(await songRowBytes()).toBe(one);
    expect(await songBytes()).toBe(one);
    expect(await projectBytes()).toBe(one);
    expect(await libraryBytes()).toBe(one);

    // A second version: the track counts both, files they share once.
    await tusUpload(t, admin, tone, "Bass.wav", { type: "newVersion", trackId: bass?.id ?? "" });
    await settle();
    const two = (await tracks())[0]?.bytes ?? 0;
    const versions = (
      await call(t, listTrackVersions, { params: { id: bass?.id ?? "" } }, admin)
    ).json<{ versions: TrackVersion[] }>().versions;
    expect(versions).toHaveLength(2);
    const perVersion = versions.map((v) => v.storedBytes ?? 0);
    expect(two).toBeGreaterThan(one);
    expect(two).toBeLessThan(perVersion.reduce((a, b) => a + b, 0)); // the WAV is shared
    expect(await projectBytes()).toBe(two);

    // Removing full quality drops the lossless files.
    expect(
      (await call(t, batchRemoveLossless, { body: { songs: [songId] } }, admin)).statusCode,
    ).toBe(200);
    const after = (await tracks())[0]?.bytes ?? 0;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(two);
    expect(await projectBytes()).toBe(after);
  }, 120_000);

  it("hides the project's size from users who see it only partly", async () => {
    expect(await libraryBytes(guest)).toBeNull();
    expect(await projectBytes(guest)).toBeNull();
  });
});
