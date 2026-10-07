import fs from "node:fs/promises";
import http from "node:http";
import { BWF_FILE, matrix, MP3_FILE } from "@bandroom/fixtures";
import {
  getBlob,
  getTrackVersionRow,
  getVariant,
  listEvents,
  LocalStorage,
} from "@bandroom/server-core";
import { ApiErrorSchema, deleteTrack, UploadResultSchema, updateProject } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { call, loginAs, runQueuedJobs, seedUser, tusUpload } from "../testing/testApp";
import {
  admin,
  member,
  projectId,
  setupUploadFixtures,
  songId,
  t,
  tracksOf,
  waitFor,
} from "../testing/uploadFixtures";

setupUploadFixtures();

describe("upload → ingest → tracks → download (SPEC §5)", () => {
  let versionId = "";
  let trackId = "";

  it("uploads a WAV as a new track (contributor) and ingests it", async () => {
    const data = await fs.readFile(BWF_FILE());
    const res = await tusUpload(t, member, data, "Song_Bass.wav", {
      type: "newTrack",
      songId,
      name: "Bass",
    });
    expect(res.status).toBe(200);
    const result = UploadResultSchema.parse(JSON.parse(res.body));
    versionId = result.trackVersionId ?? "";
    trackId = result.trackId ?? "";

    const before = await tracksOf(member);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      name: "Bass",
      versionCount: 1,
      current: { status: "queued", number: 1 },
    });

    expect(await runQueuedJobs(t)).toEqual(["done"]);
    const [track] = await tracksOf(member);
    expect(track?.current).toMatchObject({
      status: "ready",
      originalFilename: "Song_Bass.wav",
      media: { sampleRate: 48_000, lossless: true },
    });
    expect(track?.current?.variants.opus?.durationSamples48k).toBe(4 * 48_000 + 1);
    expect(track?.current?.variants.peaks?.overview).toHaveLength(1024);
    expect(track?.current?.downloads).toEqual(["flac", "wav", "opus"]);
    expect(listEvents(t.db, { action: "version.uploaded" })).toHaveLength(1);
  }, 60_000);

  it("serves blobs with auth, ETag and byte ranges", async () => {
    const [track] = await tracksOf(member);
    const hash = track?.current?.variants.opus?.hash ?? "";
    const url = `/api/v1/blobs/${hash}`;
    const full = await t.app.inject({ url, headers: { cookie: member } });
    expect(full.statusCode).toBe(200);
    expect(full.headers["content-type"]).toBe("audio/ogg");
    expect(full.headers.etag).toBe(`"${hash}"`);
    expect(full.headers["cache-control"]).toContain("immutable");
    expect(full.rawPayload.subarray(0, 4).toString("ascii")).toBe("OggS");

    const part = await t.app.inject({ url, headers: { cookie: member, range: "bytes=0-99" } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(100);
    expect(part.headers["content-range"]).toBe(`bytes 0-99/${full.rawPayload.length}`);
    expect(
      (await t.app.inject({ url, headers: { cookie: member, range: "bytes=999999999-" } }))
        .statusCode,
    ).toBe(416);
    expect(
      (await t.app.inject({ url, headers: { cookie: member, "if-none-match": `"${hash}"` } }))
        .statusCode,
    ).toBe(304);

    // Anonymous and users without access get 404.
    expect((await t.app.inject({ url })).statusCode).toBe(401);
    await seedUser(t, "outsider", "guest");
    expect(
      (await t.app.inject({ url, headers: { cookie: await loginAs(t, "outsider") } })).statusCode,
    ).toBe(404);
  });

  it("downloads FLAC, Opus and a WAV identical to the uploaded file", async () => {
    const dl = (format: string) =>
      t.app.inject({
        url: `/api/v1/track-versions/${versionId}/download?format=${format}`,
        headers: { cookie: member },
      });
    const wav = await dl("wav");
    expect(wav.statusCode).toBe(200);
    expect(wav.headers["content-disposition"]).toContain('filename="Song_Bass.wav"');
    expect(wav.rawPayload.equals(await fs.readFile(BWF_FILE()))).toBe(true);

    const flac = await dl("flac");
    expect(flac.rawPayload.subarray(0, 4).toString("ascii")).toBe("fLaC");
    expect((await dl("opus")).headers["content-type"]).toBe("audio/ogg");
    expect((await dl("original")).statusCode).toBe(404); // not kept after verification
    expect(listEvents(t.db, { action: "asset.downloaded" }).length).toBeGreaterThanOrEqual(3);
  });

  it("applies the download policy (streaming stays allowed)", async () => {
    const lossless = (await tracksOf(member))[0]?.current;
    const flacHash = lossless?.variants.flac?.hash ?? "";
    const flacIndex = lossless?.variants.seekIndex.flac ?? "";
    expect(flacHash).toMatch(/^[0-9a-f]{64}$/);
    expect(flacIndex).toMatch(/^[0-9a-f]{64}$/);
    // A fresh session: the per-session blob access cache must not carry earlier decisions.
    const fresh = await loginAs(t, "petr");
    await call(
      t,
      updateProject,
      { params: { id: projectId }, body: { downloadPolicy: "editors" } },
      admin,
    );
    const res = await t.app.inject({
      url: `/api/v1/track-versions/${versionId}/download?format=flac`,
      headers: { cookie: member },
    });
    expect(res.statusCode).toBe(403);
    const [track] = await tracksOf(member);
    expect(track?.current?.downloads).toEqual([]);
    // Lossless audio counts as a download (SPEC §3.4, DECISIONS 2026-10-01).
    expect(track?.current?.variants.flac).toBeNull();
    expect(track?.current?.variants.seekIndex.flac).toBeNull();
    expect(track?.current?.variants.seekIndex.opus).toMatch(/^[0-9a-f]{64}$/);
    const blob = (hash: string, cookie: string) =>
      t.app.inject({ url: `/api/v1/blobs/${hash}`, headers: { cookie } });
    expect((await blob(track?.current?.variants.opus?.hash ?? "", fresh)).statusCode).toBe(200);
    expect((await blob(track?.current?.variants.peaks?.hash ?? "", fresh)).statusCode).toBe(200);
    expect((await blob(track?.current?.variants.seekIndex.opus ?? "", fresh)).statusCode).toBe(200);
    expect(ApiErrorSchema.parse((await blob(flacHash, fresh)).json()).code).toBe("NOT_FOUND");
    expect((await blob(flacIndex, fresh)).statusCode).toBe(404);
    // Editors may still download, so they also get the FLAC.
    expect((await blob(flacHash, admin)).statusCode).toBe(200);
    expect((await tracksOf(admin))[0]?.current?.variants.flac?.hash).toBe(flacHash);
    await call(
      t,
      updateProject,
      { params: { id: projectId }, body: { downloadPolicy: "all" } },
      admin,
    );
    const again = await loginAs(t, "petr");
    expect((await blob(flacHash, again)).statusCode).toBe(200);
  });

  it("adds a new version to an existing track and reconstructs dual-mono WAVs as stereo", async () => {
    const f = matrix().find((x) => x.name === "imp_44100_s16_dualmono");
    if (!f) throw new Error("fixture");
    const res = await tusUpload(t, member, await fs.readFile(f.file), "bass_v2.wav", {
      type: "newVersion",
      trackId,
    });
    const v2 = UploadResultSchema.parse(JSON.parse(res.body)).trackVersionId ?? "";
    await runQueuedJobs(t);
    const [track] = await tracksOf(member);
    expect(track).toMatchObject({
      versionCount: 2,
      current: { number: 2, media: { dualMono: true } },
    });
    const wav = await t.app.inject({
      url: `/api/v1/track-versions/${v2}/download?format=wav`,
      headers: { cookie: member },
    });
    expect(wav.rawPayload.equals(await fs.readFile(f.file))).toBe(true);
  }, 60_000);

  it("rebuilds one WAV at a time and frees the slot on finish and abort (SPEC §19.6)", async () => {
    const url = `/api/v1/track-versions/${versionId}/download?format=wav`;
    const hold = t.ffmpegSlots.tryAcquire();
    expect(hold).not.toBeNull();
    try {
      const busy = await t.app.inject({ url, headers: { cookie: member } });
      expect(busy.statusCode).toBe(429);
      expect(ApiErrorSchema.parse(busy.json())).toMatchObject({
        code: "RATE_LIMITED",
        params: { retryAfterSec: 5 },
      });
      // Formats that need no ffmpeg are not affected.
      const flac = await t.app.inject({
        url: `/api/v1/track-versions/${versionId}/download?format=flac`,
        headers: { cookie: member },
      });
      expect(flac.statusCode).toBe(200);
    } finally {
      hold?.();
    }
    const ok = await t.app.inject({ url, headers: { cookie: member } });
    expect(ok.statusCode).toBe(200);
    expect(ok.rawPayload.equals(await fs.readFile(BWF_FILE()))).toBe(true);
    await waitFor(() => t.ffmpegSlots.inUse === 0);

    // Over a real socket: a full download, then one the client abandons after the first bytes.
    const address = await t.app.listen({ host: "127.0.0.1", port: 0 });
    const get = (abandon: boolean) =>
      new Promise<number>((resolve, reject) => {
        const req = http.get(`${address}${url}`, { headers: { cookie: member } }, (res) => {
          let bytes = 0;
          res.on("data", (c: Buffer) => {
            bytes += c.length;
            if (abandon) {
              req.destroy();
              resolve(bytes);
            }
          });
          res.on("end", () => {
            resolve(bytes);
          });
          res.on("error", reject);
        });
        req.on("error", (err) => {
          if (!abandon) reject(err);
        });
      });
    expect(await get(false)).toBe((await fs.stat(BWF_FILE())).size);
    await waitFor(() => t.ffmpegSlots.inUse === 0);
    expect(await get(true)).toBeGreaterThan(0);
    await waitFor(() => t.ffmpegSlots.inUse === 0);
    expect((await t.app.inject({ url, headers: { cookie: member } })).statusCode).toBe(200);
  }, 60_000);

  it("aborts a WAV download whose rebuild fails and does not log it (review M7)", async () => {
    const url = `/api/v1/track-versions/${versionId}/download?format=wav`;
    const version = getTrackVersionRow(t.db, versionId);
    const flac = version && getVariant(t.db, version.assetId, "flac");
    const blob = flac && getBlob(t.db, flac.blobHash);
    if (!blob) throw new Error("no flac blob");
    const file = await new LocalStorage(t.config.blobsDir).localPath(blob.storageKey);
    const good = await fs.readFile(file);
    const downloads = () =>
      listEvents(t.db, { action: "asset.downloaded" }).filter((e) => e.targetId === versionId)
        .length;
    const before = downloads();
    await fs.chmod(file, 0o644);
    await fs.writeFile(file, Buffer.from("this is not a flac file"));
    try {
      const bound = t.app.server.address();
      const address =
        bound && typeof bound === "object"
          ? `http://127.0.0.1:${String(bound.port)}`
          : await t.app.listen({ host: "127.0.0.1", port: 0 });
      const result = await new Promise<{ length: number; bytes: number; complete: boolean }>(
        (resolve, reject) => {
          const req = http.get(`${address}${url}`, { headers: { cookie: member } }, (res) => {
            let bytes = 0;
            const length = Number(res.headers["content-length"]);
            res.on("data", (c: Buffer) => (bytes += c.length));
            res.on("close", () => {
              resolve({ length, bytes, complete: res.complete });
            });
          });
          req.on("error", reject);
        },
      );
      expect(result.complete).toBe(false);
      expect(result.bytes).toBeLessThan(result.length);
      await waitFor(() => t.ffmpegSlots.inUse === 0);
      expect(downloads()).toBe(before);
    } finally {
      await fs.writeFile(file, good);
    }
    const ok = await t.app.inject({ url, headers: { cookie: member } });
    expect(ok.rawPayload.equals(await fs.readFile(BWF_FILE()))).toBe(true);
    expect(downloads()).toBe(before + 1);
  }, 60_000);

  it("keeps lossy originals and offers no lossless formats", async () => {
    const res = await tusUpload(t, admin, await fs.readFile(MP3_FILE()), "mix.mp3", {
      type: "newTrack",
      songId,
      name: "Mix",
      role: "mix",
    });
    expect(res.status).toBe(200);
    await runQueuedJobs(t);
    const mix = (await tracksOf(admin)).find((x) => x.name === "Mix");
    expect(mix).toMatchObject({
      role: "mix",
      current: { media: { lossless: false }, downloads: ["original", "opus"] },
    });
    expect(mix?.current?.variants.opus?.bitrate).toBe(128);
  }, 60_000);

  it("lets uploaders delete their own track; others need editor rights", async () => {
    const mix = (await tracksOf(admin)).find((x) => x.name === "Mix");
    const forbidden = await call(t, deleteTrack, { params: { id: mix?.id ?? "" } }, member);
    expect(ApiErrorSchema.parse(forbidden.json()).code).toBe("FORBIDDEN");
    expect((await call(t, deleteTrack, { params: { id: mix?.id ?? "" } }, admin)).statusCode).toBe(
      200,
    );
    expect((await tracksOf(admin)).map((x) => x.name)).toEqual(["Bass"]);
  });
});

describe("download rate limit", () => {
  it("limits each client to 30 downloads a minute", async () => {
    const [track] = await tracksOf(member);
    const url = `/api/v1/track-versions/${track?.current?.id ?? ""}/download?format=opus`;
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) {
      codes.push((await t.app.inject({ url, headers: { cookie: member } })).statusCode);
    }
    const limited = await t.app.inject({ url, headers: { cookie: member } });
    expect(codes).toContain(429);
    expect(ApiErrorSchema.parse(limited.json()).code).toBe("RATE_LIMITED");
  });
});
