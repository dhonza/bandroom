import { listEvents } from "@bandroom/server-core";
import {
  createMixerSnapshot,
  createProject,
  createSong,
  deleteMixerSnapshot,
  getSongMixer,
  putSongMixer,
  updateMe,
  type MixerState,
} from "@bandroom/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "../testing/testApp";

let t: TestApp;
let admin: string;
let member: string;
let guest: string;
let songId: string;

const state = (gainDb: number): MixerState => ({
  tracks: { t1: { gainDb, pan: 0, mute: false, solo: true, listenedVersionId: "v2" } },
});

beforeAll(async () => {
  t = await createTestApp();
  await seedUser(t, "boss", "admin");
  await seedUser(t, "petr", "member");
  await seedUser(t, "host", "guest");
  admin = await loginAs(t, "boss");
  member = await loginAs(t, "petr");
  guest = await loginAs(t, "host");
  const projectId = (await call(t, createProject, { body: { name: "Album" } }, admin)).json<{
    project: { id: string };
  }>().project.id;
  songId = (
    await call(t, createSong, { params: { id: projectId }, body: { title: "Song" } }, admin)
  ).json<{ song: { id: string } }>().song.id;
});
afterAll(async () => {
  await t.close();
});

describe("personal mixer state (SPEC §11.3)", () => {
  it("is empty at first, saved per user, and not shared", async () => {
    const empty = await call(t, getSongMixer, { params: { id: songId } }, member);
    expect(empty.json()).toEqual({ state: null, snapshots: [] });
    const put = await call(
      t,
      putSongMixer,
      { params: { id: songId }, body: { state: state(-6) } },
      member,
    );
    expect(put.statusCode).toBe(200);
    await call(t, putSongMixer, { params: { id: songId }, body: { state: state(-3) } }, member);
    expect((await call(t, getSongMixer, { params: { id: songId } }, member)).json()).toMatchObject({
      state: state(-3),
    });
    expect((await call(t, getSongMixer, { params: { id: songId } }, admin)).json()).toMatchObject({
      state: null,
    });
  });

  it("rejects invalid state and hides songs the user cannot see", async () => {
    const bad = await call(
      t,
      putSongMixer,
      { params: { id: songId }, body: { state: { tracks: { t1: { gainDb: 20 } } } } },
      member,
    );
    expect(bad.statusCode).toBe(400);
    expect((await call(t, getSongMixer, { params: { id: songId } }, guest)).statusCode).toBe(404);
  });

  it("creates and deletes snapshots, logging both", async () => {
    const res = await call(
      t,
      createMixerSnapshot,
      { params: { id: songId }, body: { name: " Me on bass ", state: state(-1) } },
      member,
    );
    expect(res.statusCode).toBe(200);
    const snap = res.json<{ snapshot: { id: string; name: string } }>().snapshot;
    expect(snap.name).toBe("Me on bass");
    const listed = (await call(t, getSongMixer, { params: { id: songId } }, member)).json<{
      snapshots: { id: string }[];
    }>();
    expect(listed.snapshots.map((s) => s.id)).toEqual([snap.id]);
    // Another user cannot delete it.
    const other = await call(
      t,
      deleteMixerSnapshot,
      { params: { id: songId, snapshotId: snap.id } },
      admin,
    );
    expect(other.statusCode).toBe(404);
    const del = await call(
      t,
      deleteMixerSnapshot,
      { params: { id: songId, snapshotId: snap.id } },
      member,
    );
    expect(del.statusCode).toBe(200);
    const actions = listEvents(t.db).map((e) => e.action);
    expect(actions).toContain("mixer.snapshot_saved");
    expect(actions).toContain("mixer.snapshot_deleted");
  });

  it("stores the user's instrument tag", async () => {
    const res = await call(t, updateMe, { body: { instrumentTag: " bass " } }, member);
    expect(res.json<{ user: { instrumentTag: string } }>().user.instrumentTag).toBe("bass");
  });
});
