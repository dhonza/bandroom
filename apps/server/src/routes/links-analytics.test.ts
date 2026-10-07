import { listEvents, purgeExpiredLinkSessions } from "@bandroom/server-core";
import {
  adminListLinks,
  createProjectLink,
  getLinkAnalytics,
  listProjectLinks,
  LinkAnalyticsSchema,
  type PublicLink,
} from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import {
  admin,
  codeOf,
  editor,
  editorId,
  makeLink,
  mixV1,
  openAs,
  projectId,
  setupLinkFixtures,
  songId,
  t,
  tokenOf,
  visit,
} from "../testing/linkFixtures";
import { call } from "../testing/testApp";

setupLinkFixtures();

describe("analytics and management", () => {
  it("counts opens, visitors, plays, downloads and comments", async () => {
    const link = await makeLink({ scopeType: "song", allowComments: true, allowDownload: true });
    const token = tokenOf(link);
    const a = await openAs(link);
    const b = await openAs(link);
    await visit(token, "POST", `/songs/${songId}/played`, { cookie: a, body: { mode: "listen" } });
    await visit(token, "POST", `/songs/${songId}/played`, { cookie: a, body: { mode: "listen" } });
    await visit(token, "POST", `/songs/${songId}/played`, {
      cookie: b,
      body: { mode: "rehearse" },
    });
    await visit(token, "GET", `/track-versions/${mixV1}/download?format=opus`, { cookie: b });
    await visit(token, "PUT", "/visitor", { cookie: b, body: { name: "Bea" } });
    await visit(token, "POST", `/songs/${songId}/comments`, { cookie: b, body: { body: "Nice" } });
    const res = await call(t, getLinkAnalytics, { params: { id: link.id } }, editor);
    const an = LinkAnalyticsSchema.parse(res.json());
    expect(an.stats).toMatchObject({ opens: 2, visitors: 2, plays: 2, downloads: 1, comments: 1 });
    expect(an.songs).toEqual([{ songId, title: "Song", plays: 2, downloads: 1, comments: 1 }]);
    expect(an.recent.some((r) => r.visitorName === "Bea" && r.action === "comment.created")).toBe(
      true,
    );
    expect(an.recent.every((r) => r.visitor === null || /^[0-9a-f]{6}$/.test(r.visitor))).toBe(
      true,
    );

    // Maintenance drops expired unnamed sessions (review M5); stats come from events and the
    // named visitor keeps their name in the activity list.
    t.db.$client.prepare("UPDATE link_sessions SET expires_at = 1 WHERE link_id = ?").run(link.id);
    expect(purgeExpiredLinkSessions(t.db)).toBeGreaterThanOrEqual(1);
    const left = t.db.$client
      .prepare("SELECT anonymous_name AS name FROM link_sessions WHERE link_id = ?")
      .all(link.id);
    expect(left).toEqual([{ name: "Bea" }]);
    const after = LinkAnalyticsSchema.parse(
      (await call(t, getLinkAnalytics, { params: { id: link.id } }, editor)).json(),
    );
    expect(after.stats).toMatchObject({ opens: 2, visitors: 2 });
    expect(after.recent.some((r) => r.visitorName === "Bea")).toBe(true);
  });

  it("creates no link when its event cannot be written (review M14)", async () => {
    const count = () =>
      (t.db.$client.prepare("SELECT count(*) AS n FROM public_links").get() as { n: number }).n;
    const before = count();
    t.db.$client.exec(`CREATE TEMP TRIGGER no_link_events BEFORE INSERT ON events
      WHEN NEW.action = 'link.created'
      BEGIN SELECT RAISE(ABORT, 'event log unavailable'); END`);
    try {
      await expect(makeLink({ scopeType: "song" })).rejects.toThrow(/create link: 500/);
      expect(count()).toBe(before);
    } finally {
      t.db.$client.exec("DROP TRIGGER no_link_events");
    }
  });

  it("lists links for project and song managers and admins", async () => {
    const pl = await makeLink({ scopeType: "project", label: "Whole album" });
    const projectLinks = (
      await call(t, listProjectLinks, { params: { id: projectId } }, editor)
    ).json<{
      links: PublicLink[];
    }>().links;
    expect(projectLinks.some((l) => l.id === pl.id && l.label === "Whole album")).toBe(true);
    expect(projectLinks.some((l) => l.scopeType === "song")).toBe(true);
    const all = (await call(t, adminListLinks, {}, admin)).json<{ links: PublicLink[] }>().links;
    expect(all.length).toBe(projectLinks.length);
    expect(codeOf(await call(t, adminListLinks, {}, editor))).toBe("FORBIDDEN");
    const wrongScope = await call(
      t,
      createProjectLink,
      {
        params: { id: projectId },
        body: {
          scopeType: "song",
          label: "",
          versions: "all",
          expiresAt: null,
          allowDownload: false,
          allowComments: false,
          showComments: false,
        },
      },
      editor,
    );
    expect(codeOf(wrongScope)).toBe("BAD_REQUEST");
    const created = listEvents(t.db, { action: "link.created" }).find((e) => e.targetId === pl.id);
    expect(created).toMatchObject({ actorType: "user", actorUserId: editorId, linkId: pl.id });
  });
});
