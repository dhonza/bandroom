import {
  adminGetSettings,
  adminUpdateSettings,
  ApiErrorSchema,
  createProject,
  createSong,
  deleteProject,
  deleteSong,
  getProject,
  getSong,
  listProjectGrants,
  listProjects,
  listProjectSongs,
  listSongGrants,
  listUsersDirectory,
  ProjectSchema,
  ProjectSummarySchema,
  removeProjectGrant,
  reorderSongs,
  setProjectGrant,
  setSongGrant,
  SongSummarySchema,
  transferProjectOwnership,
  updateProject,
  updateSong,
  GrantRowSchema,
} from "@bandroom/shared";
import { getUserById, listEvents } from "@bandroom/server-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "../testing/testApp";
import { makeFilter } from "./stream";

let t: TestApp;
let admin: string;
let member: string;
let memberId: string;
let guest: string;
let guestId: string;

beforeEach(async () => {
  t = await createTestApp();
  await seedUser(t, "boss", "admin");
  memberId = (await seedUser(t, "petr", "member")).id;
  guestId = (await seedUser(t, "producer", "guest")).id;
  admin = await loginAs(t, "boss");
  member = await loginAs(t, "petr");
  guest = await loginAs(t, "producer");
});
afterEach(async () => {
  await t.close();
});

const projectsOf = async (cookie: string, archived = false) =>
  z
    .object({ projects: z.array(ProjectSummarySchema) })
    .parse((await call(t, listProjects, { query: { archived: String(archived) } }, cookie)).json())
    .projects;

const songsOf = async (cookie: string, id: string) =>
  z
    .object({ songs: z.array(SongSummarySchema) })
    .parse((await call(t, listProjectSongs, { params: { id } }, cookie)).json()).songs;

async function newProject(cookie: string, name = "Album") {
  const res = await call(t, createProject, { body: { name, color: "teal" } }, cookie);
  expect(res.statusCode).toBe(200);
  return ProjectSchema.parse(res.json<{ project: unknown }>().project);
}

async function newSong(cookie: string, projectId: string, title: string) {
  const res = await call(t, createSong, { params: { id: projectId }, body: { title } }, cookie);
  expect(res.statusCode).toBe(200);
  return SongSummarySchema.parse(res.json<{ song: unknown }>().song);
}

const code = (res: { json: () => unknown }) => ApiErrorSchema.parse(res.json()).code;

describe("projects", () => {
  it("lets members create projects and makes them owner + manager", async () => {
    const p = await newProject(member);
    expect(p).toMatchObject({
      name: "Album",
      color: "teal",
      visibility: "full",
      ownerId: memberId,
    });
    expect(p.access.role).toBe("manager");
    expect(listEvents(t.db, { action: "project.created" })).toHaveLength(1);
    expect((await call(t, createProject, { body: { name: "No" } }, guest)).statusCode).toBe(403);
  });

  it("shows projects to members by default (contributor) but not to guests (none)", async () => {
    const p = await newProject(admin);
    expect((await projectsOf(member)).map((x) => [x.id, x.access.role])).toEqual([
      [p.id, "contributor"],
    ]);
    expect(await projectsOf(guest)).toEqual([]);
    expect(code(await call(t, getProject, { params: { id: p.id } }, guest))).toBe("NOT_FOUND");
  });

  it("updates, archives and unarchives with events", async () => {
    const p = await newProject(member);
    const res = await call(
      t,
      updateProject,
      { params: { id: p.id }, body: { name: "Renamed", downloadPolicy: "editors" } },
      member,
    );
    expect(res.json()).toMatchObject({ project: { name: "Renamed", downloadPolicy: "editors" } });
    await call(t, updateProject, { params: { id: p.id }, body: { archived: true } }, member);
    expect(await projectsOf(member)).toEqual([]);
    expect((await projectsOf(member, true)).map((x) => x.id)).toEqual([p.id]);
    await call(t, updateProject, { params: { id: p.id }, body: { archived: false } }, member);
    expect((await projectsOf(member)).map((x) => x.id)).toEqual([p.id]);
    expect(listEvents(t.db).map((e) => e.action)).toEqual(
      expect.arrayContaining(["project.updated", "project.archived", "project.unarchived"]),
    );
  });

  it("soft-deletes projects (managers only)", async () => {
    const p = await newProject(admin);
    expect((await call(t, deleteProject, { params: { id: p.id } }, member)).statusCode).toBe(403);
    expect((await call(t, deleteProject, { params: { id: p.id } }, admin)).statusCode).toBe(200);
    expect(await projectsOf(admin)).toEqual([]);
    expect(code(await call(t, getProject, { params: { id: p.id } }, admin))).toBe("NOT_FOUND");
  });

  it("tells members who could see the project that it was deleted (SSE)", async () => {
    const p = await newProject(admin);
    const user = getUserById(t.db, memberId);
    if (!user) throw new Error("user");
    const frames: string[] = [];
    t.hub.subscribe({ canSee: makeFilter(t, user), send: (f) => frames.push(f) }, null);
    expect((await call(t, deleteProject, { params: { id: p.id } }, admin)).statusCode).toBe(200);
    expect(frames.some((f) => f.includes("project.deleted") && f.includes(p.id))).toBe(true);
  });

  it("transfers ownership and grants the new owner manager", async () => {
    const p = await newProject(admin);
    const res = await call(
      t,
      transferProjectOwnership,
      { params: { id: p.id }, body: { userId: memberId } },
      admin,
    );
    expect(res.json()).toMatchObject({ project: { ownerId: memberId, ownerDisplayName: "Petr" } });
    const again = await call(t, getProject, { params: { id: p.id } }, member);
    expect(again.json()).toMatchObject({ project: { access: { role: "manager" } } });
    expect(listEvents(t.db, { action: "project.ownership_transferred" })).toHaveLength(1);
  });
});

describe("songs", () => {
  it("creates, orders, edits and deletes songs", async () => {
    const p = await newProject(admin);
    const a = await newSong(admin, p.id, "Intro");
    const b = await newSong(admin, p.id, "Ballad");
    const c = await newSong(admin, p.id, "Closer");
    expect((await songsOf(admin, p.id)).map((s) => s.title)).toEqual(["Intro", "Ballad", "Closer"]);

    const frames: string[] = [];
    const off = t.hub.subscribe({ canSee: () => true, send: (f) => frames.push(f) }, null);
    await call(t, reorderSongs, { params: { id: p.id }, body: { songIds: [c.id, a.id] } }, admin);
    expect((await songsOf(admin, p.id)).map((s) => s.title)).toEqual(["Closer", "Intro", "Ballad"]);
    // Other open project pages follow live.
    expect(frames.some((f) => f.includes('"type":"project.updated"'))).toBe(true);
    off();

    const upd = await call(
      t,
      updateSong,
      { params: { id: b.id }, body: { key: "D minor", notes: "slow" } },
      admin,
    );
    expect(upd.json()).toMatchObject({
      song: { key: "D minor", notes: "slow", project: { id: p.id } },
    });

    expect((await call(t, deleteSong, { params: { id: b.id } }, admin)).statusCode).toBe(200);
    expect((await songsOf(admin, p.id)).map((s) => s.title)).toEqual(["Closer", "Intro"]);
    expect(code(await call(t, getSong, { params: { id: b.id } }, admin))).toBe("NOT_FOUND");

    const summary = (await projectsOf(admin)).find((x) => x.id === p.id);
    expect(summary?.songCount).toBe(2);
    expect(listEvents(t.db).map((e) => e.action)).toEqual(
      expect.arrayContaining(["song.created", "songs.reordered", "song.updated", "song.deleted"]),
    );
  });

  it("contributors (member default) cannot create songs; editors can", async () => {
    const p = await newProject(admin);
    expect(
      (await call(t, createSong, { params: { id: p.id }, body: { title: "X" } }, member))
        .statusCode,
    ).toBe(403);
    await call(
      t,
      setProjectGrant,
      { params: { id: p.id, userId: memberId }, body: { role: "editor" } },
      admin,
    );
    expect(
      (await call(t, createSong, { params: { id: p.id }, body: { title: "X" } }, member))
        .statusCode,
    ).toBe(200);
  });
});

describe("grants and three-layer resolution", () => {
  it("M2 acceptance: a guest with a single song grant sees only that song", async () => {
    const p = await newProject(admin, "Secret album");
    const visible = await newSong(admin, p.id, "Demo for producer");
    const hidden = await newSong(admin, p.id, "Unfinished");
    await newProject(admin, "Other project");

    const grant = await call(
      t,
      setSongGrant,
      { params: { id: visible.id, userId: guestId }, body: { role: "commenter" } },
      admin,
    );
    expect(grant.statusCode).toBe(200);

    const list = await projectsOf(guest);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: p.id,
      visibility: "reduced",
      songCount: 1,
      access: { role: "none" },
    });
    expect((await songsOf(guest, p.id)).map((s) => [s.title, s.access.role])).toEqual([
      ["Demo for producer", "commenter"],
    ]);
    expect((await call(t, getSong, { params: { id: visible.id } }, guest)).statusCode).toBe(200);
    expect(code(await call(t, getSong, { params: { id: hidden.id } }, guest))).toBe("NOT_FOUND");
    expect((await call(t, getProject, { params: { id: p.id } }, guest)).json()).toMatchObject({
      project: { visibility: "reduced", songCount: 1 },
    });
    // Reduced visibility is view-only at project level.
    expect(
      code(await call(t, createSong, { params: { id: p.id }, body: { title: "x" } }, guest)),
    ).toBe("FORBIDDEN");
  });

  it("a song-level none hides a song from a member", async () => {
    const p = await newProject(admin);
    const s1 = await newSong(admin, p.id, "Open");
    const s2 = await newSong(admin, p.id, "Hidden");
    await call(
      t,
      setSongGrant,
      { params: { id: s2.id, userId: memberId }, body: { role: "none" } },
      admin,
    );
    expect((await songsOf(member, p.id)).map((s) => s.id)).toEqual([s1.id]);
    expect((await projectsOf(member))[0]?.songCount).toBe(1);
  });

  it("a project-level none hides the project; removing the grant restores the default", async () => {
    const p = await newProject(admin);
    await call(
      t,
      setProjectGrant,
      { params: { id: p.id, userId: memberId }, body: { role: "none" } },
      admin,
    );
    expect(await projectsOf(member)).toEqual([]);
    await call(t, removeProjectGrant, { params: { id: p.id, userId: memberId } }, admin);
    expect((await projectsOf(member)).map((x) => x.access.role)).toEqual(["contributor"]);
    const events = listEvents(t.db, { action: "grant.changed" });
    expect(events.map((e) => JSON.parse(e.details ?? "{}") as unknown)).toEqual([
      { scope: "project", before: null, after: "none" },
      { scope: "project", before: "none", after: null },
    ]);
  });

  it("lists grant rows with inherited and effective roles", async () => {
    const p = await newProject(admin);
    const s = await newSong(admin, p.id, "Song");
    await call(
      t,
      setProjectGrant,
      { params: { id: p.id, userId: memberId }, body: { role: "editor" } },
      admin,
    );
    await call(
      t,
      setSongGrant,
      { params: { id: s.id, userId: guestId }, body: { role: "viewer" } },
      admin,
    );

    const rows = z.object({ grants: z.array(GrantRowSchema) });
    const pRows = rows.parse(
      (await call(t, listProjectGrants, { params: { id: p.id } }, admin)).json(),
    ).grants;
    expect(pRows.find((r) => r.username === "petr")).toMatchObject({
      grant: "editor",
      inherited: "contributor",
      effective: "editor",
    });
    expect(pRows.find((r) => r.username === "producer")).toMatchObject({
      grant: null,
      inherited: "none",
      effective: "none",
    });
    expect(pRows.find((r) => r.username === "boss")).toMatchObject({
      grant: "manager",
      effective: "admin",
    });

    const sRows = rows.parse(
      (await call(t, listSongGrants, { params: { id: s.id } }, admin)).json(),
    ).grants;
    expect(sRows.find((r) => r.username === "petr")).toMatchObject({
      grant: null,
      inherited: "editor",
      effective: "editor",
    });
    expect(sRows.find((r) => r.username === "producer")).toMatchObject({
      grant: "viewer",
      inherited: "none",
      effective: "viewer",
    });
  });

  it("instance default roles apply to projects without grants", async () => {
    const p = await newProject(admin);
    const settings = await call(
      t,
      adminUpdateSettings,
      { body: { defaultProjectRoleGuest: "viewer", defaultProjectRoleMember: "editor" } },
      admin,
    );
    expect(settings.json()).toMatchObject({
      settings: { defaultProjectRoleGuest: "viewer", defaultProjectRoleMember: "editor" },
    });
    expect((await projectsOf(guest)).map((x) => [x.id, x.access.role])).toEqual([[p.id, "viewer"]]);
    expect((await projectsOf(member))[0]?.access.role).toBe("editor");
    expect((await call(t, adminGetSettings, {}, admin)).json()).toMatchObject({
      settings: { defaultProjectRoleMember: "editor" },
    });
    expect(listEvents(t.db, { action: "settings.changed" })).toHaveLength(1);
  });
});

describe("user directory", () => {
  it("lists active users for members, not for guests", async () => {
    const res = await call(t, listUsersDirectory, {}, member);
    expect(
      res
        .json<{ users: { username: string }[] }>()
        .users.map((u) => u.username)
        .sort(),
    ).toEqual(["boss", "petr", "producer"]);
    expect((await call(t, listUsersDirectory, {}, guest)).statusCode).toBe(403);
  });
});
