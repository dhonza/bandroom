import { createSongLink } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import {
  bassV1,
  bassV2,
  blob,
  codeOf,
  editor,
  hashOfVersion,
  makeLink,
  mixV1,
  openAs,
  otherTrack,
  projectId,
  setupLinkFixtures,
  song2Id,
  songId,
  t,
  tokenOf,
  tracksVia,
  visit,
} from "../testing/linkFixtures";
import { call } from "../testing/testApp";

setupLinkFixtures();

describe("what a link shows", () => {
  it("all tracks, current versions only", async () => {
    const link = await makeLink({ scopeType: "song" });
    const token = tokenOf(link);
    const cookie = await openAs(link);
    const tracks = await tracksVia(token, cookie);
    expect(tracks.map((x) => x.name).sort()).toEqual(["Bass", "Mix"]);
    expect(tracks.find((x) => x.name === "Bass")?.versionCount).toBe(1);
    const bassId = tracks.find((x) => x.name === "Bass")?.id ?? "";
    const versions = (await visit(token, "GET", `/tracks/${bassId}/versions`, { cookie })).json<{
      versions: { id: string }[];
    }>().versions;
    expect(versions.map((v) => v.id)).toEqual([bassV2]);
    expect((await blob(token, cookie, hashOfVersion(bassV2))).statusCode).toBe(200);
    expect((await blob(token, cookie, hashOfVersion(bassV1))).statusCode).toBe(404);
    // Another song of the project and other projects stay out of reach.
    expect((await visit(token, "GET", `/songs/${song2Id}/tracks`, { cookie })).statusCode).toBe(
      404,
    );
    expect(
      (await blob(token, cookie, otherTrack.current?.variants.opus?.hash ?? "")).statusCode,
    ).toBe(404);
    expect(
      (await visit(token, "GET", `/tracks/${otherTrack.id}/versions`, { cookie })).statusCode,
    ).toBe(404);
    // The song DTO carries visitor capabilities only, and no internal notes.
    const song = (await visit(token, "GET", `/songs/${songId}`, { cookie })).json<{
      song: { access: { role: string; capabilities: string[] }; notes: string };
    }>().song;
    expect(song.access).toEqual({ role: "viewer", capabilities: ["view", "stream"] });
    expect(song.notes).toBe("");
  });

  it("all versions lets visitors browse the stack", async () => {
    const link = await makeLink({ scopeType: "song", versions: "all" });
    const cookie = await openAs(link);
    expect(
      (await tracksVia(tokenOf(link), cookie)).find((x) => x.name === "Bass")?.versionCount,
    ).toBe(2);
    expect((await blob(tokenOf(link), cookie, hashOfVersion(bassV1))).statusCode).toBe(200);
  });

  it("shows every track and queues the ready songs (no content option, SPEC §27)", async () => {
    // A client still sending the removed `content: "mix-only"` gets an ordinary link.
    const link = await makeLink({ scopeType: "project", ...({ content: "mix-only" } as object) });
    expect(link).not.toHaveProperty("content");
    const token = tokenOf(link);
    const cookie = await openAs(link);
    expect((await tracksVia(token, cookie)).map((x) => x.name).sort()).toEqual(["Bass", "Mix"]);
    expect((await blob(token, cookie, hashOfVersion(bassV2))).statusCode).toBe(200);
    expect((await visit(token, "GET", `/songs/${songId}/listen`, { cookie })).statusCode).toBe(404);
    const queue = (await visit(token, "GET", `/projects/${projectId}/queue`, { cookie })).json<{
      items: { songId: string; ready: boolean }[];
    }>().items;
    expect(queue).toEqual([
      expect.objectContaining({ songId, ready: true }),
      expect.objectContaining({ songId: song2Id, ready: true }),
    ]);
  });

  it("a versions link shows exactly its versions", async () => {
    const link = await makeLink({ scopeType: "versions", versionIds: [bassV1] });
    const token = tokenOf(link);
    const cookie = await openAs(link);
    const tracks = await tracksVia(token, cookie);
    expect(tracks.map((x) => [x.name, x.current?.id])).toEqual([["Bass", bassV1]]);
    expect((await blob(token, cookie, hashOfVersion(bassV1))).statusCode).toBe(200);
    expect((await blob(token, cookie, hashOfVersion(bassV2))).statusCode).toBe(404);
    expect((await blob(token, cookie, hashOfVersion(mixV1))).statusCode).toBe(404);
    const bad = await call(
      t,
      createSongLink,
      {
        params: { id: songId },
        body: {
          scopeType: "versions",
          versionIds: [otherTrack.current?.id ?? ""],
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
    expect(codeOf(bad)).toBe("BAD_REQUEST");
  });
});
