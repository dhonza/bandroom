import { hashLinkToken, listEvents } from "@bandroom/server-core";
import { API_PREFIX, LinkOpenResultSchema, revokeLink, updateLink } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { LINK_COOKIE } from "../http/linkAuth";
import {
  admin,
  codeOf,
  cookieOf,
  editor,
  makeLink,
  openAs,
  setupLinkFixtures,
  songId,
  t,
  tokenOf,
  visit,
} from "../testing/linkFixtures";
import { call } from "../testing/testApp";

setupLinkFixtures();

describe("tokens and lookup", () => {
  it("stores only a hash and a sealed copy of the 128-bit token", async () => {
    const link = await makeLink({ scopeType: "song" });
    const token = tokenOf(link);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(link.url).toBe(`${t.config.appUrl}/l/${token}`);
    const row = t.db.$client
      .prepare("SELECT * FROM public_links WHERE id = ?")
      .get(link.id) as Record<string, unknown>;
    expect(row.token_hash).toBe(hashLinkToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("answers unknown, malformed, inactive, expired and revoked links the same way", async () => {
    const inactive = await makeLink({ scopeType: "song" });
    await call(t, updateLink, { params: { id: inactive.id }, body: { active: false } }, editor);
    const expired = await makeLink({ scopeType: "song", expiresAt: Date.now() + 60_000 });
    t.db.$client.prepare("UPDATE public_links SET expires_at = 1 WHERE id = ?").run(expired.id);
    const revoked = await makeLink({ scopeType: "song" });
    await call(t, revokeLink, { params: { id: revoked.id } }, editor);
    const bodies = new Set<string>();
    for (const token of [
      "AAAAAAAAAAAAAAAAAAAAAA",
      "not-a-token",
      tokenOf(inactive),
      tokenOf(expired),
      tokenOf(revoked),
    ]) {
      const res = await visit(token, "POST", "/open");
      expect(res.statusCode).toBe(404);
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
  });
});

describe("sessions", () => {
  it("sets a signed cookie scoped to the link's API path", async () => {
    const link = await makeLink({ scopeType: "song" });
    const res = await visit(tokenOf(link), "POST", "/open");
    const c = res.cookies.find((x) => x.name === LINK_COOKIE);
    expect(c?.path).toBe(`${t.basePath}${API_PREFIX}/l/${tokenOf(link)}`);
    expect(c?.httpOnly).toBe(true);
    expect(c?.sameSite).toBe("Lax");
    expect(LinkOpenResultSchema.parse(res.json()).state).toBe("open");
    const opened = listEvents(t.db, { action: "link.opened" }).filter((e) => e.linkId === link.id);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.actorType).toBe("link");
    expect(opened[0]?.linkSessionId).not.toBeNull();
  });

  it("requires a session for data and rejects tampered or foreign cookies", async () => {
    const a = await makeLink({ scopeType: "song" });
    const b = await makeLink({ scopeType: "song" });
    const cookieA = await openAs(a);
    expect(codeOf(await visit(tokenOf(a), "GET", `/songs/${songId}/tracks`))).toBe(
      "UNAUTHENTICATED",
    );
    expect(
      (await visit(tokenOf(a), "GET", `/songs/${songId}/tracks`, { cookie: cookieA })).statusCode,
    ).toBe(200);
    // A's cookie is bound to A: it does not open B.
    expect(
      codeOf(await visit(tokenOf(b), "GET", `/songs/${songId}/tracks`, { cookie: cookieA })),
    ).toBe("UNAUTHENTICATED");
    const tampered = `${cookieA.slice(0, -2)}xx`;
    expect(
      codeOf(await visit(tokenOf(a), "GET", `/songs/${songId}/tracks`, { cookie: tampered })),
    ).toBe("UNAUTHENTICATED");
    const sessionId = decodeURIComponent(cookieA.split("=")[1] ?? "").split(".")[0] ?? "";
    t.db.$client.prepare("UPDATE link_sessions SET expires_at = 1 WHERE id = ?").run(sessionId);
    expect(
      codeOf(await visit(tokenOf(a), "GET", `/songs/${songId}/tracks`, { cookie: cookieA })),
    ).toBe("UNAUTHENTICATED");
  });

  it("ignores a band member's own login on link routes", async () => {
    const link = await makeLink({ scopeType: "song" });
    const res = await visit(tokenOf(link), "POST", "/open", { cookie: admin });
    const cookie = cookieOf(res) ?? "";
    await visit(tokenOf(link), "GET", `/songs/${songId}/tracks`, { cookie: `${admin}; ${cookie}` });
    const e = listEvents(t.db, { action: "link.opened" }).find((x) => x.linkId === link.id);
    expect(e?.actorType).toBe("link");
    expect(e?.actorUserId).toBeNull();
  });
});
