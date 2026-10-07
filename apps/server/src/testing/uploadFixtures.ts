import { generateFixtures } from "@bandroom/fixtures";
import { createProject, createSong, listSongTracks, TrackSchema } from "@bandroom/shared";
import { afterAll, beforeAll } from "vitest";
import { z } from "zod";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "./testApp";

/**
 * Fixtures shared by the upload tests (`routes/uploads*.test.ts`). The `let` exports are live
 * bindings: each test file calls `setupUploadFixtures()` and reads them.
 */

export let t: TestApp;
export let admin: string;
export let member: string;
export let memberId: string;
export let projectId: string;
export let songId: string;

/**
 * Registers the shared setup of the upload tests: an admin ("boss"), a member ("petr", contributor
 * by default) and the song "Song" in the project "Album". The exported bindings are filled in
 * before the first test.
 */
export function setupUploadFixtures(): void {
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
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });
}

export async function waitFor(cond: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const tracksOf = async (cookie: string) =>
  z
    .object({ tracks: z.array(TrackSchema) })
    .parse((await call(t, listSongTracks, { params: { id: songId } }, cookie)).json()).tracks;
