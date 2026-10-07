import { listEvents } from "@bandroom/server-core";
import { listNotifications, LinkOpenResultSchema, updateLink } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import {
  codeOf,
  cookieOf,
  editor,
  makeLink,
  setupLinkFixtures,
  songId,
  t,
  tokenOf,
  visit,
} from "../testing/linkFixtures";
import { call } from "../testing/testApp";

setupLinkFixtures();

describe("passwords", () => {
  it("unlocks with the right password, logs failures and tells the link owner once", async () => {
    const link = await makeLink({ scopeType: "song", password: "open sesame" });
    expect(link.hasPassword).toBe(true);
    const token = tokenOf(link);
    const open = await visit(token, "POST", "/open");
    expect(LinkOpenResultSchema.parse(open.json())).toEqual({ state: "password" });
    expect(cookieOf(open)).toBeUndefined();
    expect(codeOf(await visit(token, "GET", `/songs/${songId}/tracks`))).toBe("UNAUTHENTICATED");

    for (let i = 0; i < 2; i++) {
      const bad = await visit(token, "POST", "/unlock", { body: { password: "nope" } });
      expect(codeOf(bad)).toBe("WRONG_PASSWORD");
      expect(cookieOf(bad)).toBeUndefined();
    }
    const failures = listEvents(t.db, { action: "link.password_failed" }).filter(
      (e) => e.linkId === link.id,
    );
    expect(failures).toHaveLength(2);
    const notes = (await call(t, listNotifications, { query: {} }, editor)).json<{
      notifications: { type: string; payload: { linkId?: string } }[];
    }>().notifications;
    expect(
      notes.filter((n) => n.type === "link_password_failed" && n.payload.linkId === link.id),
    ).toHaveLength(1);

    const ok = await visit(token, "POST", "/unlock", { body: { password: "open sesame" } });
    expect(ok.statusCode).toBe(200);
    const cookie = cookieOf(ok) ?? "";
    expect((await visit(token, "GET", `/songs/${songId}/tracks`, { cookie })).statusCode).toBe(200);
    expect(
      LinkOpenResultSchema.parse((await visit(token, "POST", "/open", { cookie })).json()).state,
    ).toBe("open");

    // Changing the password ends existing sessions.
    await call(
      t,
      updateLink,
      { params: { id: link.id }, body: { password: "new secret" } },
      editor,
    );
    expect(codeOf(await visit(token, "GET", `/songs/${songId}/tracks`, { cookie }))).toBe(
      "UNAUTHENTICATED",
    );
  });

  it("rate-limits wrong passwords per link and IP", async () => {
    const link = await makeLink({ scopeType: "song", password: "right-one" });
    const token = tokenOf(link);
    for (let i = 0; i < 5; i++) {
      await visit(token, "POST", "/unlock", { body: { password: "wrong" } });
    }
    const blocked = await visit(token, "POST", "/unlock", { body: { password: "right-one" } });
    expect(codeOf(blocked)).toBe("RATE_LIMITED");
  });

  it("locks a link after many wrong passwords spread over many IPs", async () => {
    const link = await makeLink({ scopeType: "song", password: "right-one" });
    const token = tokenOf(link);
    const from = (i: number) => ({ remoteAddress: `10.0.${Math.floor(i / 200)}.${i % 200}` });
    for (let i = 0; i < 50; i++) {
      const bad = await visit(token, "POST", "/unlock", {
        body: { password: "wrong" },
        ...from(i),
      });
      expect(codeOf(bad)).toBe("WRONG_PASSWORD");
    }
    const fresh = await visit(token, "POST", "/unlock", {
      body: { password: "right-one" },
      ...from(999),
    });
    expect(codeOf(fresh)).toBe("RATE_LIMITED");
    // Other links are not affected.
    const other = await makeLink({ scopeType: "song", password: "right-one" });
    const ok = await visit(tokenOf(other), "POST", "/unlock", {
      body: { password: "right-one" },
      ...from(999),
    });
    expect(ok.statusCode).toBe(200);
  });
});
