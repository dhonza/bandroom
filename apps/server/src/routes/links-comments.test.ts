import { listEvents } from "@bandroom/server-core";
import {
  createComment,
  getSong,
  listNotifications,
  listSongComments,
  lockSong,
  unlockSong,
  type Song,
} from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import {
  admin,
  adminTracks,
  bassV1,
  codeOf,
  cookieOf,
  editor,
  makeLink,
  mixV1,
  openAs,
  setupLinkFixtures,
  songId,
  t,
  tokenOf,
  visit,
} from "../testing/linkFixtures";
import { call } from "../testing/testApp";

setupLinkFixtures();

describe("anonymous comments", () => {
  it("need comments allowed and a display name, and show up for the band", async () => {
    const quiet = await makeLink({ scopeType: "song" });
    const qc = await openAs(quiet);
    expect(
      codeOf(
        await visit(tokenOf(quiet), "POST", `/songs/${songId}/comments`, {
          cookie: qc,
          body: { body: "Hi" },
        }),
      ),
    ).toBe("FORBIDDEN");

    const link = await makeLink({ scopeType: "song", allowComments: true });
    const token = tokenOf(link);
    const cookie = await openAs(link);
    const noName = await visit(token, "POST", `/songs/${songId}/comments`, {
      cookie,
      body: { body: "Hi" },
    });
    expect(codeOf(noName)).toBe("LINK_NAME_REQUIRED");
    expect(
      (await visit(token, "PUT", "/visitor", { cookie, body: { name: "Mastering Mike" } }))
        .statusCode,
    ).toBe(200);
    const res = await visit(token, "POST", `/songs/${songId}/comments`, {
      cookie,
      body: { body: "Vocals too loud", startSec: 1.5 },
    });
    expect(res.statusCode).toBe(200);
    const c = res.json<{
      comment: { id: string; author: { kind: string; name: string }; source: string };
    }>().comment;
    expect(c.author).toMatchObject({ kind: "link", name: "Mastering Mike" });
    expect(c.source).toBe("link");
    // The band sees it; the link owner is notified.
    const band = (
      await call(t, listSongComments, { params: { id: songId }, query: {} }, admin)
    ).json<{
      comments: { id: string }[];
    }>().comments;
    expect(band.map((x) => x.id)).toContain(c.id);
    const notes = (await call(t, listNotifications, { query: {} }, editor)).json<{
      notifications: { type: string; payload: { commentId?: string } }[];
    }>().notifications;
    expect(notes.some((n) => n.type === "link_comment" && n.payload.commentId === c.id)).toBe(true);
    const ev = listEvents(t.db, { action: "comment.created" }).find((x) => x.targetId === c.id);
    expect(ev).toMatchObject({ actorType: "link", linkId: link.id });
    // Mentionable users are never listed to visitors.
    expect((await visit(token, "GET", `/songs/${songId}/mentionable`, { cookie })).json()).toEqual({
      users: [],
    });
  });

  it("hide band comments unless the link shows them", async () => {
    const band = (
      await call(
        t,
        createComment,
        { params: { id: songId }, body: { body: "Internal note" } },
        admin,
      )
    ).json<{ comment: { id: string } }>().comment;
    const hidden = await makeLink({ scopeType: "song", allowComments: true });
    const hc = await openAs(hidden);
    const seen = (
      await visit(tokenOf(hidden), "GET", `/songs/${songId}/comments`, { cookie: hc })
    ).json<{
      comments: { id: string }[];
    }>().comments;
    expect(seen.map((x) => x.id)).not.toContain(band.id);
    await visit(tokenOf(hidden), "PUT", "/visitor", { cookie: hc, body: { name: "Guest" } });
    const reply = await visit(tokenOf(hidden), "POST", `/songs/${songId}/comments`, {
      cookie: hc,
      body: { body: "Reply", parentId: band.id },
    });
    expect(codeOf(reply)).toBe("NOT_FOUND");

    const shown = await makeLink({ scopeType: "song", showComments: true });
    const sc = await openAs(shown);
    const all = (
      await visit(tokenOf(shown), "GET", `/songs/${songId}/comments`, { cookie: sc })
    ).json<{
      comments: { id: string }[];
    }>().comments;
    expect(all.map((x) => x.id)).toContain(band.id);
  });

  it("rate-limit visitor renames", async () => {
    const link = await makeLink({ scopeType: "song", allowComments: true });
    const token = tokenOf(link);
    const ip = { remoteAddress: "10.9.9.9" };
    const res = await visit(token, "POST", "/open", ip);
    const cookie = cookieOf(res) ?? "";
    for (let i = 0; i < 10; i++) {
      const ok = await visit(token, "PUT", "/visitor", { cookie, body: { name: `N${i}` }, ...ip });
      expect(ok.statusCode).toBe(200);
    }
    const blocked = await visit(token, "PUT", "/visitor", { cookie, body: { name: "X" }, ...ip });
    expect(codeOf(blocked)).toBe("RATE_LIMITED");
  });

  it("strip hidden tracks and versions from comment contexts on mix-only links", async () => {
    const bassT = adminTracks.find((x) => x.name === "Bass");
    const mixT = adminTracks.find((x) => x.name === "Mix");
    if (!bassT || !mixT) throw new Error("tracks missing");
    const top = (
      await call(
        t,
        createComment,
        { params: { id: songId }, body: { body: "Bass is late", trackId: bassT.id } },
        admin,
      )
    ).json<{ comment: { id: string } }>().comment;
    await call(
      t,
      createComment,
      { params: { id: songId }, body: { body: "Agreed", parentId: top.id } },
      admin,
    );
    const link = await makeLink({
      scopeType: "song",
      content: "mix-only",
      allowComments: true,
      showComments: true,
    });
    const token = tokenOf(link);
    const cookie = await openAs(link);
    type Seen = {
      id: string;
      trackId: string | null;
      context: { trackVersions: Record<string, string> };
      replies: { context: { trackVersions: Record<string, string> } }[];
    };
    const onlyMix = { [mixT.id]: mixV1 };
    const seen = (await visit(token, "GET", `/songs/${songId}/comments`, { cookie }))
      .json<{ comments: Seen[] }>()
      .comments.find((c) => c.id === top.id);
    expect(seen?.trackId).toBeNull();
    expect(seen?.context.trackVersions).toEqual(onlyMix);
    expect(seen?.replies[0]?.context.trackVersions).toEqual(onlyMix);

    await visit(token, "PUT", "/visitor", { cookie, body: { name: "Mia" } });
    const created = await visit(token, "POST", `/songs/${songId}/comments`, {
      cookie,
      body: { body: "Nice", context: { trackVersions: { [bassT.id]: bassV1 } } },
    });
    const mine = created.json<{ comment: Seen }>().comment;
    expect(mine.context.trackVersions).toEqual(onlyMix);
    // The band still sees the full context.
    const bandView = (await call(t, listSongComments, { params: { id: songId }, query: {} }, admin))
      .json<{ comments: Seen[] }>()
      .comments.find((c) => c.id === mine.id);
    expect(bandView?.context.trackVersions).toEqual({ [bassT.id]: bassV1, [mixT.id]: mixV1 });
  });
});

describe("song lock (SPEC §25.12)", () => {
  it("freezes visitors' comments too and shows the lock without the name", async () => {
    const link = await makeLink({ scopeType: "song", allowComments: true });
    const token = tokenOf(link);
    const cookie = await openAs(link);
    await visit(token, "PUT", "/visitor", { cookie, body: { name: "Mike" } });
    expect((await call(t, lockSong, { params: { id: songId } }, editor)).statusCode).toBe(200);
    try {
      const res = await visit(token, "POST", `/songs/${songId}/comments`, {
        cookie,
        body: { body: "Locked?" },
      });
      expect(codeOf(res)).toBe("SONG_LOCKED");
      const song = (await visit(token, "GET", `/songs/${songId}`, { cookie })).json<{
        song: Song;
      }>().song;
      expect(song.locked?.by).toEqual({ id: null, displayName: null });
      // Reading still works.
      expect((await visit(token, "GET", `/songs/${songId}/comments`, { cookie })).statusCode).toBe(
        200,
      );
    } finally {
      await call(t, unlockSong, { params: { id: songId } }, editor);
    }
    expect(
      (await call(t, getSong, { params: { id: songId } }, editor)).json<{ song: Song }>().song
        .locked,
    ).toBeNull();
    const ok = await visit(token, "POST", `/songs/${songId}/comments`, {
      cookie,
      body: { body: "Unlocked" },
    });
    expect(ok.statusCode).toBe(200);
  });
});
