import { listEvents } from "@bandroom/server-core";
import { listSongLinks, updateProject, type PublicLink } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import {
  admin,
  bassV1,
  blob,
  codeOf,
  editor,
  makeLink,
  mixV1,
  openAs,
  projectId,
  setupLinkFixtures,
  songId,
  t,
  tokenOf,
  tracksVia,
  visit,
} from "../testing/linkFixtures";
import { call } from "../testing/testApp";

setupLinkFixtures();

describe("downloads", () => {
  it("follow the link flag and the download policy", async () => {
    const closed = await makeLink({ scopeType: "song" });
    const cc = await openAs(closed);
    expect(
      (await tracksVia(tokenOf(closed), cc)).every((x) => x.current?.downloads.length === 0),
    ).toBe(true);
    expect(
      codeOf(
        await visit(tokenOf(closed), "GET", `/track-versions/${mixV1}/download?format=flac`, {
          cookie: cc,
        }),
      ),
    ).toBe("FORBIDDEN");

    const open = await makeLink({ scopeType: "song", allowDownload: true });
    const token = tokenOf(open);
    const cookie = await openAs(open);
    expect(
      (await tracksVia(token, cookie)).find((x) => x.name === "Mix")?.current?.downloads,
    ).toContain("flac");
    const dl = await visit(token, "GET", `/track-versions/${mixV1}/download?format=flac`, {
      cookie,
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-disposition"]).toContain("attachment");
    const e = listEvents(t.db, { action: "asset.downloaded" }).find((x) => x.linkId === open.id);
    expect(e?.actorType).toBe("link");
    // An older version stays hidden even with downloads on.
    expect(
      (await visit(token, "GET", `/track-versions/${bassV1}/download?format=flac`, { cookie }))
        .statusCode,
    ).toBe(404);

    await call(
      t,
      updateProject,
      { params: { id: projectId }, body: { downloadPolicy: "contributors" } },
      admin,
    );
    try {
      expect(
        codeOf(
          await visit(token, "GET", `/track-versions/${mixV1}/download?format=flac`, { cookie }),
        ),
      ).toBe("FORBIDDEN");
      const listed = (await call(t, listSongLinks, { params: { id: songId } }, editor)).json<{
        links: PublicLink[];
      }>().links;
      expect(listed.find((l) => l.id === open.id)?.downloadPolicyAllows).toBe(false);
    } finally {
      await call(
        t,
        updateProject,
        { params: { id: projectId }, body: { downloadPolicy: "all" } },
        admin,
      );
    }
  });
});

describe("lossless audio counts as a download (SPEC §3.4, DECISIONS 2026-10-01)", () => {
  it("hides FLAC hashes and refuses FLAC blobs without download rights", async () => {
    const open = await makeLink({ scopeType: "song", allowDownload: true });
    const oc = await openAs(open);
    const mixOpen = (await tracksVia(tokenOf(open), oc)).find((x) => x.name === "Mix")?.current;
    const flacHash = mixOpen?.variants.flac?.hash ?? "";
    const flacIndex = mixOpen?.variants.seekIndex.flac ?? "";
    expect(flacHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await blob(tokenOf(open), oc, flacHash)).statusCode).toBe(200);
    expect((await blob(tokenOf(open), oc, flacIndex)).statusCode).toBe(200);

    const closed = await makeLink({ scopeType: "song" });
    const token = tokenOf(closed);
    const cookie = await openAs(closed);
    const mixTrack = (await tracksVia(token, cookie)).find((x) => x.name === "Mix");
    const mix = mixTrack?.current;
    expect(mix?.variants.flac).toBeNull();
    expect(mix?.variants.seekIndex.flac).toBeNull();
    const versions = (
      await visit(token, "GET", `/tracks/${mixTrack?.id ?? ""}/versions`, { cookie })
    ).json<{ versions: { variants: { flac: unknown } }[] }>().versions;
    expect(versions.every((v) => v.variants.flac === null)).toBe(true);
    expect(codeOf(await blob(token, cookie, flacHash))).toBe("NOT_FOUND");
    expect((await blob(token, cookie, flacIndex)).statusCode).toBe(404);
    expect((await blob(token, cookie, mix?.variants.opus?.hash ?? "")).statusCode).toBe(200);
    expect((await blob(token, cookie, mix?.variants.seekIndex.opus ?? "")).statusCode).toBe(200);

    // The download policy also applies to links that allow downloads.
    await call(
      t,
      updateProject,
      { params: { id: projectId }, body: { downloadPolicy: "contributors" } },
      admin,
    );
    try {
      const again = await openAs(open);
      const hidden = (await tracksVia(tokenOf(open), again)).find((x) => x.name === "Mix");
      expect(hidden?.current?.variants.flac).toBeNull();
      expect((await blob(tokenOf(open), again, flacHash)).statusCode).toBe(404);
    } finally {
      await call(
        t,
        updateProject,
        { params: { id: projectId }, body: { downloadPolicy: "all" } },
        admin,
      );
    }
  });
});
