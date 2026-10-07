import fs from "node:fs/promises";
import { BWF_FILE } from "@bandroom/fixtures";
import {
  claimJob,
  heartbeatJob,
  requeueInterruptedJob,
  setProjectGrantRow,
} from "@bandroom/server-core";
import { getProcessing, listProjectSongs, type Processing } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { createRun, updateRun } from "../importers/samply/store";
import { call, loginAs, runQueuedJobs, seedUser, tusUpload } from "../testing/testApp";
import {
  admin,
  member,
  projectId,
  setupUploadFixtures,
  songId,
  t,
} from "../testing/uploadFixtures";

setupUploadFixtures();

const songProcessing = async (cookie: string): Promise<Processing | undefined> =>
  (await call(t, listProjectSongs, { params: { id: projectId } }, cookie))
    .json<{ songs: { id: string; processing?: Processing }[] }>()
    .songs.find((s) => s.id === songId)?.processing;

const processing = async (cookie: string) =>
  (await call(t, getProcessing, undefined, cookie)).json<{
    songs: { songId: string; title: string; projectName: string; processing: Processing }[];
    imports: { id: string; status: string; progress: number }[];
  }>();

describe("processing visibility (SPEC §25.3)", () => {
  it("counts a queued upload in the song list and the processing list", async () => {
    expect(await songProcessing(member)).toEqual({
      queued: 0,
      processing: 0,
      failed: 0,
      progress: null,
      mix: null,
    });
    expect((await processing(member)).songs).toEqual([]);

    const upload = await tusUpload(t, member, await fs.readFile(BWF_FILE()), "Bass.wav", {
      type: "newTrack",
      songId,
      name: "Bass",
    });
    expect(upload.status).toBe(200);
    expect(await songProcessing(member)).toMatchObject({ queued: 1, processing: 0, failed: 0 });
    const list = await processing(member);
    expect(list.songs).toEqual([
      {
        songId,
        title: "Song",
        projectId,
        projectName: "Album",
        processing: { queued: 1, processing: 0, failed: 0, progress: null, mix: null },
      },
    ]);
  });

  it("shows the progress of a running ingest", async () => {
    const job = claimJob(t.db, "probe", ["audio.ingest"]);
    if (!job) throw new Error("no job");
    heartbeatJob(t.db, job.id, "probe", 0.5);
    expect(await songProcessing(member)).toMatchObject({ queued: 0, processing: 1, progress: 0.5 });
    expect(requeueInterruptedJob(t.db, job.id, "probe")).toBe(true);
  });

  it("is scoped to what the user can see", async () => {
    const guest = await seedUser(t, "gast", "guest");
    const guestCookie = await loginAs(t, "gast");
    expect((await processing(guestCookie)).songs).toEqual([]);
    setProjectGrantRow(t.db, projectId, guest.id, "viewer", guest.id);
    expect((await processing(guestCookie)).songs.map((s) => s.songId)).toEqual([songId]);
  });

  it("after ingest only the debounced automatic mix is left", async () => {
    expect(await runQueuedJobs(t)).toEqual(["done"]);
    expect(await songProcessing(member)).toEqual({
      queued: 0,
      processing: 0,
      failed: 0,
      progress: null,
      mix: "queued",
    });
  }, 60_000);

  it("counts failed files", async () => {
    await tusUpload(t, member, Buffer.from("not audio at all"), "Broken.wav", {
      type: "newTrack",
      songId,
      name: "Broken",
    });
    await runQueuedJobs(t);
    expect(await songProcessing(member)).toMatchObject({ queued: 0, failed: 1 });
  }, 60_000);

  it("lists running imports for admins only", async () => {
    const adminId = (await seedUser(t, "boss2", "admin")).id;
    const run = createRun(t.db, { secretEnc: "x", createdBy: adminId });
    updateRun(t.db, run.id, { status: "running", progress: 0.4 });
    expect((await processing(admin)).imports).toEqual([
      { id: run.id, status: "running", dryRun: false, progress: 0.4 },
    ]);
    expect((await processing(member)).imports).toEqual([]);
    updateRun(t.db, run.id, { status: "done" });
    expect((await processing(admin)).imports).toEqual([]);
  });
});
