import {
  createAsset,
  createSongRow,
  createTrackWithVersion,
  listEvents,
  schema,
  setProjectGrantRow,
  setSongGrantRow,
} from "@bandroom/server-core";
import {
  createComment,
  createProject,
  deleteComment,
  getSongFollow,
  listMentionableUsers,
  listNotifications,
  listSongComments,
  putSongTempo,
  resolveComment,
  restoreComment,
  setCommentReaction,
  updateComment,
  StreamEventSchema,
  type Comment,
  type Notification,
  type StreamEvent,
} from "@bandroom/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "../testing/testApp";

let t: TestApp;
let admin: string;
let member: string; // contributor (default member role)
let viewer: string;
let commenter: string;
let ids: Record<"boss" | "petr" | "vera" | "cyril" | "hidden", string>;
let songId: string;
let trackId: string;
let versionId: string;
const published: StreamEvent[] = [];

beforeAll(async () => {
  t = await createTestApp();
  const boss = await seedUser(t, "boss", "admin");
  const petr = await seedUser(t, "petr", "member");
  const vera = await seedUser(t, "vera", "member");
  const cyril = await seedUser(t, "cyril", "member");
  const hidden = await seedUser(t, "hidden", "member");
  ids = { boss: boss.id, petr: petr.id, vera: vera.id, cyril: cyril.id, hidden: hidden.id };
  admin = await loginAs(t, "boss");
  member = await loginAs(t, "petr");
  viewer = await loginAs(t, "vera");
  commenter = await loginAs(t, "cyril");
  const projectId = (await call(t, createProject, { body: { name: "Album" } }, admin)).json<{
    project: { id: string };
  }>().project.id;
  setProjectGrantRow(t.db, projectId, vera.id, "viewer", boss.id);
  setProjectGrantRow(t.db, projectId, cyril.id, "commenter", boss.id);
  songId = createSongRow(t.db, { projectId, title: "Song", createdBy: boss.id }).id;
  setSongGrantRow(t.db, songId, hidden.id, "none", boss.id);
  const asset = createAsset(t.db, {
    kind: "audio",
    originalFilename: "bass.wav",
    sizeBytes: 1,
    originalHash: "x",
    uploadedBy: boss.id,
  });
  const tv = createTrackWithVersion(t.db, {
    songId,
    name: "Bass",
    assetId: asset.id,
    uploadedBy: boss.id,
  });
  trackId = tv.track.id;
  versionId = tv.version.id;
  t.hub.subscribe(
    {
      canSee: () => true,
      send: (frame) => {
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (data) published.push(StreamEventSchema.parse(JSON.parse(data)));
      },
    },
    null,
  );
});
afterAll(async () => {
  await t.close();
});

const create = (body: Record<string, unknown>, cookie = member) =>
  call(t, createComment, { params: { id: songId }, body }, cookie);
const created = async (body: Record<string, unknown>, cookie = member) => {
  const res = await create(body, cookie);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ comment: Comment }>().comment;
};
const list = async (cookie = member, query: Record<string, string> = {}) =>
  (await call(t, listSongComments, { params: { id: songId }, query }, cookie)).json<{
    comments: Comment[];
    nextCursor: string | null;
  }>();
const notificationsOf = async (cookie: string) =>
  (await call(t, listNotifications, {}, cookie)).json<{
    notifications: Notification[];
    unreadCount: number;
  }>();

describe("comments (SPEC §8)", () => {
  let first: Comment;

  it("creates a point comment with context, mentions and notifications", async () => {
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
    published.length = 0;
    first = await created({
      body: "Bass is **late** here @Vera, cc @hidden",
      startSec: 12.5,
      trackId,
    });
    expect(first).toMatchObject({
      songId,
      trackId,
      parentId: null,
      author: { userId: ids.petr, name: "Petr", username: "petr", kind: "user" },
      startSec: 12.5,
      endSec: null,
      deleted: false,
      editedAt: null,
      replies: [],
      mentions: [ids.vera], // `hidden` cannot see the song
    });
    expect(first.context.trackVersions).toEqual({ [trackId]: versionId });
    expect(first.context.tempoRev).toEqual(expect.any(String));

    const vera = await notificationsOf(viewer);
    expect(vera.unreadCount).toBe(1);
    expect(vera.notifications[0]).toMatchObject({
      type: "mention",
      readAt: null,
      payload: {
        songId,
        songTitle: "Song",
        projectName: "Album",
        actorName: "Petr",
        commentId: first.id,
        startSec: 12.5,
        excerpt: "Bass is late here @Vera, cc @hidden",
      },
    });
    // The uploader of the song's versions hears about comments on it.
    expect((await notificationsOf(admin)).notifications[0]).toMatchObject({
      type: "comment_on_upload",
      payload: { commentId: first.id },
    });
    expect((await notificationsOf(member)).unreadCount).toBe(0); // never about own actions

    expect(published.map((e) => [e.type, e.userId ?? null])).toEqual(
      expect.arrayContaining([
        ["comment.changed", null],
        ["notification", ids.vera],
        ["notification", ids.boss],
      ]),
    );
    const ev = listEvents(t.db, { action: "comment.created" });
    expect(ev.at(-1)).toMatchObject({ targetId: first.id, songId, actorUserId: ids.petr });
    // Commenting follows the song.
    const f = await call(t, getSongFollow, { params: { id: songId } }, member);
    expect(f.json()).toEqual({ following: true });
  });

  it("validates ranges and tracks, and viewers cannot comment", async () => {
    expect((await create({ body: "x", startSec: 5, endSec: 4 })).statusCode).toBe(400);
    expect((await create({ body: "x", trackId: "nope" })).statusCode).toBe(400);
    expect((await create({ body: "x" }, viewer)).statusCode).toBe(403);
    const range = await created({ body: "Chorus drags", startSec: 30, endSec: 45.5 });
    expect(range).toMatchObject({ startSec: 30, endSec: 45.5, trackId: null });
    const general = await created({ body: "Great take overall" }, commenter);
    expect(general).toMatchObject({ startSec: null, endSec: null });
    expect((await list(viewer)).comments.map((c) => c.body)).toEqual([
      first.body,
      "Chorus drags",
      "Great take overall",
    ]);
  });

  it("keeps replies one level deep and notifies the parent's author", async () => {
    const reply = await created({ body: "Agreed", parentId: first.id, startSec: 99 }, admin);
    expect(reply).toMatchObject({ parentId: first.id, startSec: null, trackId: null });
    const nested = await created({ body: "Me too", parentId: reply.id }, commenter);
    expect(nested.parentId).toBe(first.id);
    const top = (await list()).comments.find((c) => c.id === first.id);
    expect(top?.replies.map((r) => r.body)).toEqual(["Agreed", "Me too"]);
    const petr = await notificationsOf(member);
    expect(petr.notifications.map((n) => n.type)).toEqual(["reply", "reply"]);
    expect(petr.notifications[0]?.payload.startSec).toBe(12.5); // the parent's time
    expect(
      (await create({ body: "x", parentId: "00000000-0000-7000-8000-000000000000" })).statusCode,
    ).toBe(404);
  });

  it("edits own comments (editors any) and notifies newly mentioned users only", async () => {
    const res = await call(
      t,
      updateComment,
      { params: { id: first.id }, body: { body: "Bass is late @vera @cyril" } },
      member,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json<{ comment: Comment }>().comment).toMatchObject({
      body: "Bass is late @vera @cyril",
      editedAt: expect.any(Number) as number,
      mentions: expect.arrayContaining([ids.vera, ids.cyril]) as string[],
    });
    expect((await notificationsOf(viewer)).unreadCount).toBe(1); // not mentioned again
    expect((await notificationsOf(commenter)).notifications[0]?.type).toBe("mention");
    const other = await call(
      t,
      updateComment,
      { params: { id: first.id }, body: { body: "hijack" } },
      commenter,
    );
    expect(other.statusCode).toBe(403);
    const byEditor = await call(
      t,
      updateComment,
      { params: { id: first.id }, body: { body: "Bass is late (fixed typo) @vera @cyril" } },
      admin,
    );
    expect(byEditor.statusCode).toBe(200);
    expect(listEvents(t.db, { action: "comment.edited" })).toHaveLength(2);
  });

  it("resolves own comments, editors any; replies cannot be resolved", async () => {
    const mine = await created({ body: "Tune the snare", startSec: 3 }, commenter);
    const r1 = await call(
      t,
      resolveComment,
      { params: { id: mine.id }, body: { resolved: true } },
      commenter,
    );
    expect(r1.json<{ comment: Comment }>().comment).toMatchObject({
      resolvedAt: expect.any(Number) as number,
      resolvedByName: "Cyril",
    });
    const notMine = await call(
      t,
      resolveComment,
      { params: { id: first.id }, body: { resolved: true } },
      commenter,
    );
    expect(notMine.statusCode).toBe(403);
    const reply = (await list()).comments.find((c) => c.id === first.id)?.replies[0];
    const onReply = await call(
      t,
      resolveComment,
      { params: { id: reply?.id ?? "" }, body: { resolved: true } },
      admin,
    );
    expect(onReply.statusCode).toBe(400);
    const reopen = await call(
      t,
      resolveComment,
      { params: { id: mine.id }, body: { resolved: false } },
      admin,
    );
    expect(reopen.json<{ comment: Comment }>().comment.resolvedAt).toBeNull();
    expect(listEvents(t.db, { action: "comment.resolved" })).toHaveLength(1);
    expect(listEvents(t.db, { action: "comment.unresolved" })).toHaveLength(1);
  });

  it("toggles reactions idempotently from the fixed set", async () => {
    const react = (emoji: string, active: boolean, cookie: string) =>
      call(t, setCommentReaction, { params: { id: first.id }, body: { emoji, active } }, cookie);
    await react("👍", true, member);
    await react("👍", true, member);
    const res = await react("👍", true, commenter);
    expect(res.json<{ comment: Comment }>().comment.reactions).toEqual([
      { emoji: "👍", count: 2, mine: true },
    ]);
    await react("👍", false, member);
    const after = (await list(member)).comments.find((c) => c.id === first.id);
    expect(after?.reactions).toEqual([{ emoji: "👍", count: 1, mine: false }]);
    expect((await react("🍕", true, member)).statusCode).toBe(400);
    expect((await react("👍", true, viewer)).statusCode).toBe(403);
    expect(listEvents(t.db, { action: "comment.reaction_added" })).toHaveLength(2);
    expect(listEvents(t.db, { action: "comment.reaction_removed" })).toHaveLength(1);
  });

  it("keeps a deleted comment with replies as a placeholder; undo restores", async () => {
    const del = await call(t, deleteComment, { params: { id: first.id } }, member);
    expect(del.statusCode).toBe(200);
    const tomb = (await list()).comments.find((c) => c.id === first.id);
    expect(tomb).toMatchObject({ deleted: true, body: "", reactions: [], mentions: [] });
    expect(tomb?.replies).toHaveLength(2);
    expect(
      (await call(t, updateComment, { params: { id: first.id }, body: { body: "x" } }, member))
        .statusCode,
    ).toBe(404);
    const restored = await call(t, restoreComment, { params: { id: first.id } }, member);
    expect(restored.json<{ comment: Comment }>().comment.deleted).toBe(false);

    const lonely = await created({ body: "Delete me", startSec: 1 });
    await call(t, deleteComment, { params: { id: lonely.id } }, member);
    expect((await list()).comments.some((c) => c.id === lonely.id)).toBe(false);
    expect(
      (await call(t, deleteComment, { params: { id: lonely.id } }, commenter)).statusCode,
    ).toBe(403);
    expect(listEvents(t.db, { action: "comment.deleted" })).toHaveLength(2);
    expect(listEvents(t.db, { action: "comment.restored" })).toHaveLength(1);
  });

  it("lists imported comments with their author's name", async () => {
    t.db
      .insert(schema.comments)
      .values({
        id: "00000000-0000-7000-8000-00000000abcd",
        songId,
        body: "From Samply",
        importedAuthorName: "Old Friend",
        source: "import",
        startSec: 7,
        context: '{"trackVersions":{}}',
        createdAt: Date.now(),
      })
      .run();
    const c = (await list()).comments.find((x) => x.body === "From Samply");
    expect(c).toMatchObject({
      source: "import",
      author: { userId: null, name: "Old Friend", kind: "imported" },
      context: { trackVersions: {}, tempoRev: null },
    });
    // Only editors may act on comments without a local author.
    const res = await call(t, deleteComment, { params: { id: c?.id ?? "" } }, member);
    expect(res.statusCode).toBe(403);
  });

  it("pages top-level comments with a cursor", async () => {
    const all = (await list()).comments;
    const p1 = await list(member, { limit: "2" });
    expect(p1.comments).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await list(member, { limit: "200", cursor: p1.nextCursor ?? "" });
    expect([...p1.comments, ...p2.comments].map((c) => c.id)).toEqual(all.map((c) => c.id));
    expect(p2.nextCursor).toBeNull();
    const bad = await call(
      t,
      listSongComments,
      { params: { id: songId }, query: { cursor: "nope" } },
      member,
    );
    expect(bad.statusCode).toBe(400);
  });

  it("replays a request with the same requestId without side effects", async () => {
    const requestId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    const before = (await list()).comments.length;
    const a = await created({ body: "Once", startSec: 2, requestId });
    const b = await created({ body: "Once", startSec: 2, requestId });
    expect(b.id).toBe(a.id);
    expect((await list()).comments.length).toBe(before + 1);
  });

  it("lists mentionable users: everyone who can view the song", async () => {
    const res = await call(t, listMentionableUsers, { params: { id: songId } }, commenter);
    const names = res.json<{ users: { username: string }[] }>().users.map((u) => u.username);
    expect(names).toEqual(expect.arrayContaining(["boss", "petr", "vera", "cyril"]));
    expect(names).not.toContain("hidden");
    expect(
      (await call(t, listMentionableUsers, { params: { id: songId } }, viewer)).statusCode,
    ).toBe(403);
  });
});
