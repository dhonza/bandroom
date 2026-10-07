import { createSongLink, PublicLinkSchema, revokeLink, updateLink } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import {
  blob,
  codeOf,
  editor,
  hashOfVersion,
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

describe("revocation and lifecycle", () => {
  it("locks visitors out immediately on deactivate and revoke", async () => {
    const link = await makeLink({ scopeType: "song" });
    const token = tokenOf(link);
    const cookie = await openAs(link);
    const hash = hashOfVersion(mixV1);
    expect((await blob(token, cookie, hash)).statusCode).toBe(200);
    await call(t, updateLink, { params: { id: link.id }, body: { active: false } }, editor);
    expect((await blob(token, cookie, hash)).statusCode).toBe(404);
    await call(t, updateLink, { params: { id: link.id }, body: { active: true } }, editor);
    expect((await blob(token, cookie, hash)).statusCode).toBe(200);
    const revoked = await call(t, revokeLink, { params: { id: link.id } }, editor);
    expect(PublicLinkSchema.parse(revoked.json<{ link: unknown }>().link).status).toBe("revoked");
    expect((await blob(token, cookie, hash)).statusCode).toBe(404);
    expect((await visit(token, "GET", `/songs/${songId}/tracks`, { cookie })).statusCode).toBe(404);
    const again = await call(
      t,
      updateLink,
      { params: { id: link.id }, body: { active: true } },
      editor,
    );
    expect(codeOf(again)).toBe("BAD_REQUEST");
  });

  it("refuses expired links", async () => {
    const link = await makeLink({ scopeType: "song", expiresAt: Date.now() + 3_600_000 });
    const cookie = await openAs(link);
    t.db.$client
      .prepare("UPDATE public_links SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 1, link.id);
    expect((await visit(tokenOf(link), "GET", `/songs/${songId}`, { cookie })).statusCode).toBe(
      404,
    );
    const past = await call(
      t,
      createSongLink,
      {
        params: { id: songId },
        body: {
          scopeType: "song",
          label: "",
          content: "all-tracks",
          versions: "all",
          expiresAt: Date.now() - 1000,
          allowDownload: false,
          allowComments: false,
          showComments: false,
        },
      },
      editor,
    );
    expect(codeOf(past)).toBe("BAD_REQUEST");
  });
});
