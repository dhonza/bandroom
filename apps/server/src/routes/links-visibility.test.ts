import { createSongLink, getSongListen } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import {
  admin,
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

  it("mix-only shows the mix track, or the automatic mix", async () => {
    const link = await makeLink({ scopeType: "project", content: "mix-only" });
    const token = tokenOf(link);
    const cookie = await openAs(link);
    expect((await tracksVia(token, cookie)).map((x) => x.name)).toEqual(["Mix"]);
    expect((await blob(token, cookie, hashOfVersion(bassV2))).statusCode).toBe(404);
    const listen = (await visit(token, "GET", `/songs/${songId}/listen`, { cookie })).json<{
      listen: { trackVersionId: string } | null;
    }>().listen;
    expect(listen?.trackVersionId).toBe(mixV1);
    // Song 2 has no mix track: the automatic mix plays, its tracks stay hidden.
    expect(await tracksVia(token, cookie, song2Id)).toEqual([]);
    const auto = (await call(t, getSongListen, { params: { id: song2Id } }, admin)).json<{
      listen: { trackVersionId: string; isAutoMix: boolean; opus: { hash: string } } | null;
    }>().listen;
    expect(auto?.isAutoMix).toBe(true);
    const viaLink = (await visit(token, "GET", `/songs/${song2Id}/listen`, { cookie })).json<{
      listen: { trackVersionId: string } | null;
    }>().listen;
    expect(viaLink?.trackVersionId).toBe(auto?.trackVersionId);
    expect((await blob(token, cookie, auto?.opus.hash ?? "")).statusCode).toBe(200);
    const songs = (await visit(token, "GET", `/projects/${projectId}/songs`, { cookie })).json<{
      songs: { id: string }[];
    }>().songs;
    expect(songs.map((s) => s.id).sort()).toEqual([songId, song2Id].sort());
  });

  it("a versions link shows exactly its versions", async () => {
    const link = await makeLink({ scopeType: "versions", versionIds: [bassV1] });
    expect(link.content).toBe("all-tracks");
    const token = tokenOf(link);
    const cookie = await openAs(link);
    const tracks = await tracksVia(token, cookie);
    expect(tracks.map((x) => [x.name, x.current?.id])).toEqual([["Bass", bassV1]]);
    expect((await blob(token, cookie, hashOfVersion(bassV1))).statusCode).toBe(200);
    expect((await blob(token, cookie, hashOfVersion(bassV2))).statusCode).toBe(404);
    expect((await blob(token, cookie, hashOfVersion(mixV1))).statusCode).toBe(404);
    const listen = (await visit(token, "GET", `/songs/${songId}/listen`, { cookie })).json<{
      listen: { trackVersionId: string } | null;
    }>().listen;
    expect(listen?.trackVersionId).toBe(bassV1);
    const bad = await call(
      t,
      createSongLink,
      {
        params: { id: songId },
        body: {
          scopeType: "versions",
          versionIds: [otherTrack.current?.id ?? ""],
          label: "",
          content: "all-tracks",
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
