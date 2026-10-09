import {
  ApiErrorSchema,
  createProject,
  createSong,
  getProject,
  getProjectQueue,
  getSong,
  LibraryProjectSchema,
  listProjects,
  ProjectSchema,
  SongSummarySchema,
  setSongGrant,
  starProject,
  unstarProject,
} from "@bandroom/shared";
import { listEvents } from "@bandroom/server-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  call,
  callWithKey,
  createTestApp,
  keyFor,
  loginAs,
  seedUser,
  type TestApp,
} from "../testing/testApp";

let t: TestApp;
let admin: string;
let adminId: string;
let member: string;
let memberId: string;
let guest: string;
let guestId: string;

beforeEach(async () => {
  t = await createTestApp();
  adminId = (await seedUser(t, "boss", "admin")).id;
  memberId = (await seedUser(t, "petr", "member")).id;
  guestId = (await seedUser(t, "producer", "guest")).id;
  admin = await loginAs(t, "boss");
  member = await loginAs(t, "petr");
  guest = await loginAs(t, "producer");
});
afterEach(async () => {
  vi.useRealTimers();
  await t.close();
});

const libraryOf = async (cookie: string) =>
  z
    .object({ projects: z.array(LibraryProjectSchema) })
    .parse((await call(t, listProjects, { query: { archived: "false" } }, cookie)).json()).projects;

async function newProject(cookie: string, name = "Album") {
  const res = await call(t, createProject, { body: { name } }, cookie);
  expect(res.statusCode).toBe(200);
  return ProjectSchema.parse(res.json<{ project: unknown }>().project);
}

async function newSong(cookie: string, projectId: string, title: string) {
  const res = await call(t, createSong, { params: { id: projectId }, body: { title } }, cookie);
  expect(res.statusCode).toBe(200);
  return SongSummarySchema.parse(res.json<{ song: unknown }>().song);
}

const code = (res: { json: () => unknown }) => ApiErrorSchema.parse(res.json()).code;

describe("library fields", () => {
  it("lists the creator, creation time and the user's own (empty) state", async () => {
    const p = await newProject(admin);
    const [item] = await libraryOf(member);
    expect(item).toMatchObject({
      id: p.id,
      createdAt: p.createdAt,
      createdBy: adminId,
      createdByName: "Boss",
      starred: false,
      lastAccessedAt: null,
    });
  });
});

describe("stars", () => {
  it("stars and unstars per user, with one event per change", async () => {
    const p = await newProject(admin);
    const star = await call(t, starProject, { params: { id: p.id } }, member);
    expect(star.statusCode).toBe(200);
    // Idempotent: a second star changes nothing and writes no event.
    expect((await call(t, starProject, { params: { id: p.id } }, member)).statusCode).toBe(200);
    expect((await libraryOf(member))[0]?.starred).toBe(true);
    expect((await libraryOf(admin))[0]?.starred).toBe(false);
    const starred = listEvents(t.db, { action: "project.starred" });
    expect(starred).toHaveLength(1);
    expect(starred[0]).toMatchObject({ actorUserId: memberId, projectId: p.id, targetId: p.id });

    expect((await call(t, unstarProject, { params: { id: p.id } }, member)).statusCode).toBe(200);
    expect((await call(t, unstarProject, { params: { id: p.id } }, member)).statusCode).toBe(200);
    expect((await libraryOf(member))[0]?.starred).toBe(false);
    expect(listEvents(t.db, { action: "project.unstarred" })).toHaveLength(1);
  });

  it("needs view access: hidden projects answer NOT_FOUND, reduced views may star", async () => {
    const p = await newProject(admin);
    expect(code(await call(t, starProject, { params: { id: p.id } }, guest))).toBe("NOT_FOUND");
    expect(code(await call(t, unstarProject, { params: { id: p.id } }, guest))).toBe("NOT_FOUND");
    expect(listEvents(t.db, { action: "project.starred" })).toHaveLength(0);

    const song = await newSong(admin, p.id, "Demo");
    await call(
      t,
      setSongGrant,
      { params: { id: song.id, userId: guestId }, body: { role: "viewer" } },
      admin,
    );
    expect((await call(t, starProject, { params: { id: p.id } }, guest)).statusCode).toBe(200);
    expect((await libraryOf(guest))[0]).toMatchObject({ visibility: "reduced", starred: true });
  });
});

describe("last accessed", () => {
  it("updates when the user opens the project, a song or the queue, not other users", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const p = await newProject(admin);
    const song = await newSong(admin, p.id, "Song");
    expect((await libraryOf(member))[0]?.lastAccessedAt).toBeNull();

    vi.setSystemTime(2_000_000);
    await call(t, getProject, { params: { id: p.id } }, member);
    expect((await libraryOf(member))[0]?.lastAccessedAt).toBe(2_000_000);
    expect((await libraryOf(admin))[0]?.lastAccessedAt).toBeNull();

    vi.setSystemTime(3_000_000);
    await call(t, getSong, { params: { id: song.id } }, member);
    expect((await libraryOf(member))[0]?.lastAccessedAt).toBe(3_000_000);

    vi.setSystemTime(4_000_000);
    await call(t, getProjectQueue, { params: { id: p.id } }, member);
    const [item] = await libraryOf(member);
    expect(item?.lastAccessedAt).toBe(4_000_000);
    // Access keeps the star and writes no events.
    expect(item?.starred).toBe(false);
    expect(
      listEvents(t.db).filter((e) => e.action.startsWith("project.") && e.actorUserId === memberId),
    ).toEqual([]);
  });

  it("keeps the star when the user opens the project, and ignores API-key calls", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const p = await newProject(admin);
    await call(t, starProject, { params: { id: p.id } }, member);
    const token = keyFor(t, memberId, ["read"]);
    vi.setSystemTime(2_000_000);
    expect((await callWithKey(t, getProject, { params: { id: p.id } }, token)).statusCode).toBe(
      200,
    );
    expect((await libraryOf(member))[0]).toMatchObject({ starred: true, lastAccessedAt: null });
    await call(t, getProject, { params: { id: p.id } }, member);
    expect((await libraryOf(member))[0]).toMatchObject({
      starred: true,
      lastAccessedAt: 2_000_000,
    });
  });
});
