import fs from "node:fs/promises";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import {
  createProject,
  createSong,
  listProjectSongs,
  listSongTracks,
  type SongSummary,
  type Track,
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
let projectId: string;

beforeAll(async () => {
  await generateFixtures();
  t = await createTestApp();
  await seedUser(t, "boss", "admin");
  admin = await loginAs(t, "boss");
  projectId = (await call(t, createProject, { body: { name: "Album" } }, admin)).json<{
    project: { id: string };
  }>().project.id;
}, 60_000);
afterAll(async () => {
  await t.close();
});

const newSong = async (title: string) =>
  (await call(t, createSong, { params: { id: projectId }, body: { title } }, admin)).json<{
    song: { id: string };
  }>().song.id;
const row = async (songId: string) =>
  (await call(t, listProjectSongs, { params: { id: projectId } }, admin))
    .json<{ songs: SongSummary[] }>()
    .songs.find((s) => s.id === songId);

describe("song list length and mono/stereo (SPEC §11.2)", () => {
  it("gives ready songs their length and channel counts, and nothing to songs without audio", async () => {
    const empty = await newSong("Empty");
    const songId = await newSong("Song");
    const tone = await fs.readFile(TONE_FILE());
    await tusUpload(t, admin, tone, "Bass.wav", { type: "newTrack", songId, name: "Bass" });
    for (let pass = 0; pass < 3; pass++) {
      t.db.$client.prepare("UPDATE jobs SET run_after = 0 WHERE status = 'queued'").run();
      if ((await runQueuedJobs(t)).length === 0) break;
    }
    const [bass] = (await call(t, listSongTracks, { params: { id: songId } }, admin)).json<{
      tracks: Track[];
    }>().tracks;
    const opus = bass?.current?.variants.opus;
    expect(opus).toBeTruthy();
    const mono = opus?.channels === 1 ? 1 : 0;

    const r = await row(songId);
    expect(r?.durationSec).toBeCloseTo((opus?.durationSamples48k ?? 0) / 48_000, 6);
    expect(r?.channels).toEqual({ stereo: 1 - mono, mono });

    const e = await row(empty);
    expect(e).toBeDefined();
    expect(e?.durationSec).toBeUndefined();
    expect(e?.channels).toBeUndefined();
  }, 120_000);
});
