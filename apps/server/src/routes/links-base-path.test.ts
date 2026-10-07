import { API_PREFIX, createProject, createProjectLink, PublicLinkSchema } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { LINK_COOKIE } from "../http/linkAuth";
import { tokenOf } from "../testing/linkFixtures";
import { call, createTestApp, loginAs, seedUser } from "../testing/testApp";

describe("under a base path", () => {
  it("builds link URLs and cookie paths with the base path", async () => {
    const sub = await createTestApp({ APP_URL: "http://localhost:3100/bandroom" });
    try {
      await seedUser(sub, "boss", "admin");
      const cookie = await loginAs(sub, "boss");
      const pid = (await call(sub, createProject, { body: { name: "P" } }, cookie)).json<{
        project: { id: string };
      }>().project.id;
      const res = await call(
        sub,
        createProjectLink,
        {
          params: { id: pid },
          body: {
            scopeType: "project",
            label: "",
            content: "mix-only",
            versions: "current-only",
            expiresAt: null,
            allowDownload: false,
            allowComments: false,
            showComments: false,
          },
        },
        cookie,
      );
      const link = PublicLinkSchema.parse(res.json<{ link: unknown }>().link);
      const token = tokenOf(link);
      expect(link.url).toBe(`http://localhost:3100/bandroom/l/${token}`);
      const open = await sub.app.inject({
        method: "POST",
        url: `/bandroom${API_PREFIX}/l/${token}/open`,
        headers: { "x-requested-with": "bandroom" },
      });
      expect(open.statusCode).toBe(200);
      expect(open.cookies.find((c) => c.name === LINK_COOKIE)?.path).toBe(
        `/bandroom${API_PREFIX}/l/${token}`,
      );
    } finally {
      await sub.close();
    }
  });
});
