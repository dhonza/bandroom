import fs from "node:fs/promises";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { listEvents, setSongGrantRow } from "@bandroom/server-core";
import {
  API_PREFIX,
  createProject,
  createSong,
  createSongTextDocument,
  getProjectOfflineManifest,
  getSongOfflineManifest,
  listSongTracks,
  putSongMixer,
  recordProjectOffline,
  recordSongOffline,
  TrackSchema,
  updateProject,
  type OfflineProjectManifest,
  type OfflineSongManifest,
} from "@bandroom/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  call,
  createTestApp,
  loginAs,
  runQueuedJobs,
  seedUser,
  tusUpload,
  type TestApp,
} from "../testing/testApp";
import { offlineVariantNames } from "./offline";

let t: TestApp;
let admin: string;
let member: string;
let guest: string;
let outsider: string;
let projectId: string;
let songId: string;
let otherSongId: string;

beforeAll(async () => {
  await generateFixtures();
  t = await createTestApp();
  const boss = await seedUser(t, "boss", "admin");
  await seedUser(t, "petr", "member");
  const g = await seedUser(t, "gita", "guest");
  await seedUser(t, "olga", "guest");
  admin = await loginAs(t, "boss");
  member = await loginAs(t, "petr");
  guest = await loginAs(t, "gita");
  outsider = await loginAs(t, "olga");
  projectId = (await call(t, createProject, { body: { name: "Album" } }, admin)).json<{
    project: { id: string };
  }>().project.id;
  const song = async (title: string) =>
    (await call(t, createSong, { params: { id: projectId }, body: { title } }, admin)).json<{
      song: { id: string };
    }>().song.id;
  songId = await song("Offline song");
  otherSongId = await song("Other song");
  const tone = await fs.readFile(TONE_FILE());
  await tusUpload(t, admin, tone, "Bass.wav", { type: "newTrack", songId, name: "Bass" });
  await call(
    t,
    createSongTextDocument,
    { params: { id: songId }, body: { title: "Lyrics", kind: "markdown", text: "# La la" } },
    admin,
  );
  for (let pass = 0; pass < 3; pass++) {
    t.db.$client.prepare("UPDATE jobs SET run_after = 0 WHERE status = 'queued'").run();
    if ((await runQueuedJobs(t)).length === 0) break;
  }
  setSongGrantRow(t.db, songId, g.id, "viewer", boss.id);
}, 180_000);
afterAll(async () => {
  await t.close();
});

const songManifest = async (query: Record<string, string> = {}, cookie = member) =>
  call(t, getSongOfflineManifest, { params: { id: songId }, query }, cookie);

const get = (url: string, cookie: string, headers: Record<string, string> = {}) =>
  t.app.inject({
    method: "GET",
    url: `${t.basePath}${API_PREFIX}${url}`,
    headers: { cookie, ...headers },
  });

describe("offlineVariantNames", () => {
  const all = new Set([
    "opus",
    "opus_low",
    "flac",
    "peaks",
    "seekindex_opus",
    "seekindex_opus_low",
    "seekindex_flac",
  ]);
  it("picks Opus or Opus low with its seek index, FLAC only for lossless", () => {
    expect(offlineVariantNames(all, { quality: "normal", lossless: false })).toEqual([
      "opus",
      "seekindex_opus",
      "peaks",
    ]);
    expect(offlineVariantNames(all, { quality: "small", lossless: true })).toEqual([
      "opus_low",
      "seekindex_opus_low",
      "flac",
      "seekindex_flac",
      "peaks",
    ]);
  });
  it("falls back to the other Opus variant and skips what is missing", () => {
    expect(
      offlineVariantNames(new Set(["opus_low", "peaks"]), { quality: "normal", lossless: true }),
    ).toEqual(["opus_low", "peaks"]);
    expect(offlineVariantNames(new Set(), { quality: "small", lossless: false })).toEqual([]);
  });
});

describe("song offline manifest (SPEC §13)", () => {
  it("lists the current versions' Opus, seek index, peaks and documents with sizes", async () => {
    const res = await songManifest();
    expect(res.statusCode).toBe(200);
    const m = res.json<{ song: OfflineSongManifest }>().song;
    const tracks = z
      .object({ tracks: z.array(TrackSchema) })
      .parse((await call(t, listSongTracks, { params: { id: songId } }, member)).json()).tracks;
    const v = tracks[0]?.current;
    expect(m.trackIds).toEqual(tracks.map((x) => x.id));
    const hashes = m.blobs.map((b) => b.hash);
    expect(hashes).toContain(v?.variants.opus?.hash);
    expect(hashes).toContain(v?.variants.seekIndex.opus);
    expect(hashes).toContain(v?.variants.peaks?.hash);
    expect(hashes).not.toContain(v?.variants.opusLow?.hash);
    expect(hashes).not.toContain(v?.variants.flac?.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    // Only the track's files: no Listen-mode mix since M21 (SPEC §13, §27).
    expect(hashes.sort()).toEqual(
      [v?.variants.opus?.hash, v?.variants.seekIndex.opus, v?.variants.peaks?.hash].sort(),
    );
    expect(m.documents).toHaveLength(1);

    // Every file is readable by this user, and the sizes are right.
    for (const b of m.blobs) {
      const r = await get(`/blobs/${b.hash}`, member);
      expect(r.statusCode).toBe(200);
      expect(r.rawPayload.length).toBe(b.bytes);
    }
    const doc = m.documents[0];
    const content = await get(`/document-versions/${doc?.versionId ?? ""}/content`, member);
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.length).toBe(doc?.bytes);
  });

  it("switches to Opus low and adds FLAC on request", async () => {
    const m = (await songManifest({ quality: "small", lossless: "true" })).json<{
      song: OfflineSongManifest;
    }>().song;
    const tracks = z
      .object({ tracks: z.array(TrackSchema) })
      .parse((await call(t, listSongTracks, { params: { id: songId } }, member)).json()).tracks;
    const v = tracks[0]?.current;
    const hashes = m.blobs.map((b) => b.hash);
    expect(hashes).toContain(v?.variants.opusLow?.hash);
    expect(hashes).toContain(v?.variants.flac?.hash);
    expect(hashes).toContain(v?.variants.seekIndex.flac);
    expect(hashes).not.toContain(v?.variants.opus?.hash);
  });

  it("leaves FLAC out without download rights, also in the project manifest", async () => {
    const tracks = z
      .object({ tracks: z.array(TrackSchema) })
      .parse((await call(t, listSongTracks, { params: { id: songId } }, admin)).json()).tracks;
    const flac = tracks[0]?.current?.variants.flac?.hash ?? "";
    const flacIndex = tracks[0]?.current?.variants.seekIndex.flac ?? "";
    expect(flac).toMatch(/^[0-9a-f]{64}$/);
    await call(
      t,
      updateProject,
      { params: { id: projectId }, body: { downloadPolicy: "editors" } },
      admin,
    );
    try {
      const query = { quality: "normal", lossless: "true" };
      const m = (await songManifest(query)).json<{ song: OfflineSongManifest }>().song;
      const hashes = m.blobs.map((b) => b.hash);
      expect(hashes).not.toContain(flac);
      expect(hashes).not.toContain(flacIndex);
      expect(hashes).toContain(tracks[0]?.current?.variants.opus?.hash);
      const p = (
        await call(t, getProjectOfflineManifest, { params: { id: projectId }, query }, member)
      ).json<{ project: OfflineProjectManifest }>().project;
      expect(p.songs.flatMap((s) => s.blobs.map((b) => b.hash))).not.toContain(flac);
      // Editors may download, so their manifest keeps the FLAC.
      const own = (await songManifest(query, admin)).json<{ song: OfflineSongManifest }>().song;
      expect(own.blobs.map((b) => b.hash)).toContain(flac);
    } finally {
      await call(
        t,
        updateProject,
        { params: { id: projectId }, body: { downloadPolicy: "all" } },
        admin,
      );
    }
  });

  it("follows the song's permissions", async () => {
    expect((await songManifest({}, guest)).statusCode).toBe(200);
    expect((await songManifest({}, outsider)).statusCode).toBe(404);
    expect(
      (await call(t, getSongOfflineManifest, { params: { id: otherSongId }, query: {} }, guest))
        .statusCode,
    ).toBe(404);
  });
});

describe("project offline manifest", () => {
  it("covers every song the user can see", async () => {
    const all = (
      await call(t, getProjectOfflineManifest, { params: { id: projectId }, query: {} }, member)
    ).json<{ project: OfflineProjectManifest }>().project;
    expect(all.songs.map((s) => s.title)).toEqual(["Offline song", "Other song"]);
    expect(all.songs[0]?.blobs.length).toBeGreaterThan(0);

    // A guest with one song grant sees the project in the reduced view: that song only.
    const reduced = await call(
      t,
      getProjectOfflineManifest,
      { params: { id: projectId }, query: {} },
      guest,
    );
    expect(reduced.statusCode).toBe(200);
    const r = reduced.json<{ project: OfflineProjectManifest }>().project;
    expect(r.songs.map((s) => s.songId)).toEqual([songId]);
    expect(r.documents).toEqual([]);
  });
});

describe("offline events (SPEC §14.1)", () => {
  it("logs offline.added|removed per device, once per requestId", async () => {
    const requestId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a7d";
    const body = { action: "added", bytes: 1234, quality: "normal", requestId } as const;
    for (let i = 0; i < 2; i++) {
      expect(
        (await call(t, recordSongOffline, { params: { id: songId }, body }, member)).statusCode,
      ).toBe(200);
    }
    await call(
      t,
      recordProjectOffline,
      { params: { id: projectId }, body: { action: "removed", bytes: 0, quality: "small" } },
      member,
    );
    const added = listEvents(t.db, { action: "offline.added" });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ songId, targetType: "song", targetId: songId });
    expect(added[0]?.sessionId).toBeTruthy();
    expect(JSON.parse(added[0]?.details ?? "{}")).toEqual({ bytes: 1234, quality: "normal" });
    expect(listEvents(t.db, { action: "offline.removed" })[0]).toMatchObject({
      projectId,
      targetType: "project",
    });
    expect(
      (
        await call(
          t,
          recordSongOffline,
          { params: { id: songId }, body: { action: "added", bytes: 1, quality: "normal" } },
          outsider,
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe("listened versions in the offline manifest", () => {
  it(
    "adds the version the user's saved mix plays instead of the current one",
    { timeout: 180_000 },
    async () => {
      const tracksNow = async () =>
        z
          .object({ tracks: z.array(TrackSchema) })
          .parse((await call(t, listSongTracks, { params: { id: songId } }, member)).json()).tracks;
      const bass = (await tracksNow())[0];
      const v1 = bass?.current;
      if (!bass || !v1) throw new Error("no track");
      // A second version becomes current; the member keeps listening to v1.
      await tusUpload(t, admin, await fs.readFile(TONE_FILE()), "Bass2.wav", {
        type: "newVersion",
        trackId: bass.id,
      });
      for (let pass = 0; pass < 3; pass++) {
        t.db.$client.prepare("UPDATE jobs SET run_after = 0 WHERE status = 'queued'").run();
        if ((await runQueuedJobs(t)).length === 0) break;
      }
      const v2 = (await tracksNow())[0]?.current;
      expect(v2?.id).not.toBe(v1.id);
      const listen = (versionId: string) =>
        call(
          t,
          putSongMixer,
          {
            params: { id: songId },
            body: {
              state: {
                tracks: {
                  [bass.id]: {
                    gainDb: 0,
                    pan: 0,
                    mute: false,
                    solo: false,
                    listenedVersionId: versionId,
                  },
                },
              },
            },
          },
          member,
        );
      await listen(v1.id);
      const hashesOf = async (query: Record<string, string>, cookie = member) =>
        (await songManifest(query, cookie))
          .json<{ song: OfflineSongManifest }>()
          .song.blobs.map((b) => b.hash);
      const hashes = await hashesOf({ lossless: "true" });
      expect(hashes).toContain(v2?.variants.opus?.hash);
      expect(hashes).toContain(v1.variants.opus?.hash);
      expect(hashes).toContain(v1.variants.seekIndex.opus);
      expect(hashes).toContain(v1.variants.flac?.hash); // downloads allowed: same rule as current
      // Someone else's saved mix does not change this user's manifest.
      expect(await hashesOf({}, admin)).not.toContain(v1.variants.opus?.hash);
      const project = (
        await call(t, getProjectOfflineManifest, { params: { id: projectId }, query: {} }, member)
      ).json<{ project: OfflineProjectManifest }>().project;
      expect(project.songs.flatMap((s) => s.blobs.map((b) => b.hash))).toContain(
        v1.variants.opus?.hash,
      );

      // A version of another song's track is ignored (the saved mix is the user's input).
      await tusUpload(t, admin, await fs.readFile(TONE_FILE()), "Keys.wav", {
        type: "newTrack",
        songId: otherSongId,
        name: "Keys",
      });
      for (let pass = 0; pass < 3; pass++) {
        t.db.$client.prepare("UPDATE jobs SET run_after = 0 WHERE status = 'queued'").run();
        if ((await runQueuedJobs(t)).length === 0) break;
      }
      const keys = z
        .object({ tracks: z.array(TrackSchema) })
        .parse((await call(t, listSongTracks, { params: { id: otherSongId } }, admin)).json())
        .tracks[0]?.current;
      expect(keys?.variants.opus?.hash).toMatch(/^[0-9a-f]{64}$/);
      await listen(keys?.id ?? "");
      expect(await hashesOf({ lossless: "true" })).not.toContain(keys?.variants.opus?.hash);
    },
  );
});
