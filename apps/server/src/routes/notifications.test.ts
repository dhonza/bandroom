import {
  createNotifications,
  createSongRow,
  getUserById,
  listEvents,
  NOTIFICATIONS_KEEP,
  setProjectGrantRow,
  updateUser,
} from "@bandroom/server-core";
import {
  createProject,
  createSong,
  getProjectFollow,
  getUnreadNotificationCount,
  listNotifications,
  markNotificationsRead,
  requestPasswordReset,
  setProjectFollow,
  setProjectGrant,
  setSongFollow,
  setSongGrant,
  type Notification,
} from "@bandroom/shared";
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

let t: TestApp;
let admin: string;
let member: string;
let guest: string;
let ids: Record<"boss" | "petr" | "gina" | "boss2", string>;
let projectId: string;

beforeAll(async () => {
  t = await createTestApp();
  const boss = await seedUser(t, "boss", "admin");
  const boss2 = await seedUser(t, "boss2", "admin");
  const petr = await seedUser(t, "petr", "member");
  const gina = await seedUser(t, "gina", "guest");
  ids = { boss: boss.id, petr: petr.id, gina: gina.id, boss2: boss2.id };
  admin = await loginAs(t, "boss");
  member = await loginAs(t, "petr");
  guest = await loginAs(t, "gina");
  projectId = (await call(t, createProject, { body: { name: "Album" } }, admin)).json<{
    project: { id: string };
  }>().project.id;
});
afterAll(async () => {
  await t.close();
});

const inbox = async (cookie: string, query: Record<string, string> = {}) =>
  (await call(t, listNotifications, { query }, cookie)).json<{
    notifications: Notification[];
    nextCursor: string | null;
    unreadCount: number;
  }>();

describe("notifications (SPEC §16, in-app only)", () => {
  it("creators follow their project; new songs notify the project's followers", async () => {
    const f = await call(t, getProjectFollow, { params: { id: projectId } }, admin);
    expect(f.json()).toEqual({ following: true });
    const on = await call(
      t,
      setProjectFollow,
      { params: { id: projectId }, body: { following: true } },
      member,
    );
    expect(on.json()).toEqual({ following: true });
    expect(listEvents(t.db, { action: "follow.added" })).toHaveLength(1);
    await call(t, createSong, { params: { id: projectId }, body: { title: "New one" } }, admin);
    const n = await inbox(member);
    expect(n.notifications[0]).toMatchObject({
      type: "new_song",
      payload: { songTitle: "New one", projectName: "Album", actorName: "Boss" },
    });
    expect((await inbox(admin)).notifications.some((x) => x.type === "new_song")).toBe(false);
  });

  it("notifies a grantee, only about real access", async () => {
    await call(
      t,
      setProjectGrant,
      { params: { id: projectId, userId: ids.gina }, body: { role: "none" } },
      admin,
    );
    expect((await inbox(guest)).unreadCount).toBe(0);
    await call(
      t,
      setProjectGrant,
      { params: { id: projectId, userId: ids.gina }, body: { role: "commenter" } },
      admin,
    );
    expect((await inbox(guest)).notifications[0]).toMatchObject({
      type: "granted",
      payload: { projectId, projectName: "Album", role: "commenter" },
    });
    const songId = createSongRow(t.db, { projectId, title: "Solo", createdBy: ids.boss }).id;
    await call(
      t,
      setSongGrant,
      { params: { id: songId, userId: ids.gina }, body: { role: "editor" } },
      admin,
    );
    expect((await inbox(guest)).notifications[0]).toMatchObject({
      type: "granted",
      payload: { songId, songTitle: "Solo", role: "editor" },
    });
  });

  it("notifies song followers about new versions and warns about the quota", async () => {
    const songId = createSongRow(t.db, { projectId, title: "Takes", createdBy: ids.boss }).id;
    await call(t, setSongFollow, { params: { id: songId }, body: { following: true } }, admin);
    updateUser(t.db, ids.petr, { quotaBytes: 1000 });
    const res = await tusUpload(t, member, Buffer.alloc(850, 1), "bass.wav", {
      type: "newTrack",
      songId,
      name: "Bass",
    });
    expect(res.status).toBe(200);
    expect((await inbox(admin)).notifications[0]).toMatchObject({
      type: "new_version",
      payload: { songId, trackName: "Bass", versionNumber: 1, actorName: "Petr" },
    });
    const petr = await inbox(member);
    expect(petr.notifications[0]).toMatchObject({
      type: "quota_warning",
      payload: { percent: 85 },
    });
    updateUser(t.db, ids.petr, { quotaBytes: null });
  });

  it("notifies admins about reset requests, once while unread", async () => {
    const before = (await inbox(admin)).unreadCount;
    await call(t, requestPasswordReset, { body: { login: "gina" } });
    await call(t, requestPasswordReset, { body: { login: "gina" } });
    const n = await inbox(admin);
    expect(n.unreadCount).toBe(before + 1);
    expect(n.notifications[0]).toMatchObject({
      type: "reset_request",
      payload: { userId: ids.gina, username: "gina", actorName: "Gina" },
    });
    expect((await inbox(await loginAs(t, "boss2"))).notifications[0]?.type).toBe("reset_request");
  });

  it("lists with a cursor, counts unread and marks read", async () => {
    const all = await inbox(admin);
    const p1 = await inbox(admin, { limit: "1" });
    expect(p1.notifications).toHaveLength(1);
    const p2 = await inbox(admin, { limit: "100", cursor: p1.nextCursor ?? "" });
    expect([...p1.notifications, ...p2.notifications].map((n) => n.id)).toEqual(
      all.notifications.map((n) => n.id),
    );
    const firstId = all.notifications[0]?.id ?? "";
    await call(t, markNotificationsRead, { body: { ids: [firstId] } }, admin);
    const count = await call(t, getUnreadNotificationCount, {}, admin);
    expect(count.json()).toEqual({ count: all.unreadCount - 1 });
    expect((await inbox(admin, { unread: "true" })).notifications.map((n) => n.id)).not.toContain(
      firstId,
    );
    // Someone else's ids are ignored.
    await call(t, markNotificationsRead, { body: { ids: [firstId] } }, member);
    await call(t, markNotificationsRead, { body: { all: true } }, admin);
    expect((await inbox(admin)).unreadCount).toBe(0);
    expect((await call(t, listNotifications, {}, undefined)).statusCode).toBe(401);
  });

  it("skips the actor, disabled users and users who cannot see the song; caps the list", () => {
    const songId = createSongRow(t.db, { projectId, title: "Hidden", createdBy: ids.boss }).id;
    setProjectGrantRow(t.db, projectId, ids.gina, "none", ids.boss);
    const created = createNotifications(t.db, {
      type: "mention",
      userIds: [ids.boss, ids.petr, ids.gina, ids.petr],
      actorId: ids.boss,
      payload: { songId },
      songId,
      projectId,
    });
    expect(created.map((c) => c.userId)).toEqual([ids.petr]);
    updateUser(t.db, ids.petr, { disabledAt: Date.now() });
    expect(
      createNotifications(t.db, { type: "reply", userIds: [ids.petr], actorId: null, payload: {} }),
    ).toEqual([]);
    updateUser(t.db, ids.petr, { disabledAt: null });
    for (let i = 0; i < NOTIFICATIONS_KEEP + 5; i++) {
      createNotifications(t.db, {
        type: "reply",
        userIds: [ids.boss2],
        actorId: null,
        payload: {},
      });
    }
    const n = t.db.$client
      .prepare("SELECT count(*) AS n FROM notifications WHERE user_id = ?")
      .get(ids.boss2) as { n: number };
    expect(n.n).toBe(NOTIFICATIONS_KEEP);
  });

  it("delivers user-targeted SSE events to that user only", () => {
    const boss = getUserById(t.db, ids.boss);
    const petr = getUserById(t.db, ids.petr);
    if (!boss || !petr) throw new Error("users missing");
    const event = { type: "notification", userId: ids.petr, data: {} };
    expect(makeFilter(t, petr)(event)).toBe(true);
    expect(makeFilter(t, boss)(event)).toBe(false); // not even admins
  });
});
