import fs from "node:fs/promises";
import { crc32 } from "node:zlib";
import { AIFF_FILE, generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { listEvents, setProjectGrantRow, setSongGrantRow } from "@bandroom/server-core";
import {
  API_PREFIX,
  ApiErrorSchema,
  batchRemoveLossless,
  createProject,
  createProjectTextDocument,
  createSong,
  getProjectExportPreview,
  updateSong,
  type ProjectExportPreview,
} from "@bandroom/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  createTestApp,
  loginAs,
  runQueuedJobs,
  seedUser,
  tusUpload,
  type TestApp,
} from "../testing/testApp";

let t: TestApp;
const cookies: Record<string, string> = {};
let projectId = "";

/** Entries of a (non-ZIP64) archive, read through its central directory. */
function unzip(zip: Buffer): { name: string; data: Buffer; crc: number }[] {
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  let p = zip.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < zip.readUInt16LE(eocd + 10); i++) {
    const nameLen = zip.readUInt16LE(p + 28);
    const size = zip.readUInt32LE(p + 24);
    const offset = zip.readUInt32LE(p + 42);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    out.push({
      name: zip.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
      data: zip.subarray(start, start + size),
      crc: zip.readUInt32LE(p + 16),
    });
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return out;
}

const download = (format: string, who: string) =>
  t.app.inject({
    url: `${t.basePath}${API_PREFIX}/projects/${projectId}/export/download?format=${format}`,
    headers: { cookie: cookies[who] ?? "" },
  });
const preview = async (format: "flac" | "wav" | "opus" | "original", who: string) => {
  const res = await call(
    t,
    getProjectExportPreview,
    { params: { id: projectId }, query: { format } },
    cookies[who],
  );
  expect(res.statusCode, res.body).toBe(200);
  return res.json<ProjectExportPreview>();
};

beforeAll(async () => {
  await generateFixtures();
  t = await createTestApp();
  const boss = await seedUser(t, "boss", "admin");
  const petr = await seedUser(t, "petr", "member");
  const eva = await seedUser(t, "eva", "member");
  const gita = await seedUser(t, "gita", "guest");
  await seedUser(t, "olga", "guest");
  for (const n of ["boss", "petr", "eva", "gita", "olga"]) cookies[n] = await loginAs(t, n);
  const admin = cookies.boss ?? "";
  projectId = (await call(t, createProject, { body: { name: "Album" } }, admin)).json<{
    project: { id: string };
  }>().project.id;
  const song = async (title: string) =>
    (await call(t, createSong, { params: { id: projectId }, body: { title } }, admin)).json<{
      song: { id: string };
    }>().song.id;
  const duo = await song("Duo");
  const solo = await song("Solo");
  const secret = await song("Secret");
  await song("Empty");
  const tone = await fs.readFile(TONE_FILE());
  const aiff = await fs.readFile(AIFF_FILE());
  await tusUpload(t, admin, tone, "a.wav", { type: "newTrack", songId: duo, name: "Bass" });
  await tusUpload(t, admin, aiff, "b.aiff", { type: "newTrack", songId: duo, name: "Bass" });
  await tusUpload(t, admin, tone, "g.wav", { type: "newTrack", songId: solo, name: "Gtr" });
  await tusUpload(t, admin, tone, "s.wav", { type: "newTrack", songId: secret, name: "Keys" });
  await call(
    t,
    createProjectTextDocument,
    { params: { id: projectId }, body: { title: "Setlist", kind: "text", text: "1. Duo\n" } },
    admin,
  );
  for (let pass = 0; pass < 3; pass++) {
    t.db.$client.prepare("UPDATE jobs SET run_after = 0 WHERE status = 'queued'").run();
    if ((await runQueuedJobs(t)).length === 0) break;
  }
  // Solo keeps only Opus; Secret is for editors only.
  await call(t, batchRemoveLossless, { body: { songs: [solo] } }, admin);
  await call(t, updateSong, { params: { id: secret }, body: { downloadPolicy: "editors" } }, admin);
  setProjectGrantRow(t.db, projectId, petr.id, "contributor", boss.id);
  setProjectGrantRow(t.db, projectId, eva.id, "editor", boss.id);
  setSongGrantRow(t.db, solo, gita.id, "viewer", boss.id);
}, 180_000);
afterAll(async () => {
  await t.close();
});

describe("project export (SPEC §28.7)", () => {
  it("previews and streams the layout with fallbacks, exact length and an event", async () => {
    const p = await preview("flac", "petr");
    expect(p).toMatchObject({
      songs: 2,
      skippedSongs: 1,
      documents: 1,
      files: 4,
      opusFallbacks: 1,
      originalFallbacks: 0,
    });
    const res = await download("flac", "petr");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(String(res.headers["content-disposition"])).toContain('filename="Album.zip"');
    expect(Number(res.headers["content-length"])).toBe(res.rawPayload.length);
    expect(res.rawPayload.length).toBe(p.bytes);
    const entries = unzip(res.rawPayload);
    expect(entries.map((e) => e.name)).toEqual([
      "Album/Duo/Bass.flac",
      "Album/Duo/Bass (2).flac",
      "Album/Solo.opus",
      "Album/Documents/Setlist.txt",
    ]);
    for (const e of entries) expect(e.crc).toBe(crc32(e.data) >>> 0);
    expect(entries[0]?.data.subarray(0, 4).toString("latin1")).toBe("fLaC");
    expect(entries[2]?.data.subarray(0, 4).toString("latin1")).toBe("OggS");
    expect(entries[3]?.data.toString()).toBe("1. Duo\n");
    const ev = listEvents(t.db, { action: "project.exported" }).at(-1);
    expect(ev).toMatchObject({ projectId, targetId: projectId });
    expect(JSON.parse(ev?.details ?? "{}")).toEqual({
      format: "flac",
      songs: 2,
      files: 4,
      bytes: p.bytes,
    });
  }, 60_000);

  it("includes songs the policy allows for editors", async () => {
    const p = await preview("opus", "eva");
    expect(p).toMatchObject({ songs: 3, skippedSongs: 0, files: 5, opusFallbacks: 0 });
  });

  it("rebuilds WAV with the single ffmpeg slot, busy → RATE_LIMITED", async () => {
    const hold = t.ffmpegSlots.tryAcquire();
    try {
      const busy = await download("wav", "boss");
      expect(busy.statusCode).toBe(429);
      expect(ApiErrorSchema.parse(busy.json()).code).toBe("RATE_LIMITED");
    } finally {
      hold?.();
    }
    const res = await download("wav", "boss");
    expect(res.statusCode).toBe(200);
    expect(Number(res.headers["content-length"])).toBe(res.rawPayload.length);
    const entries = unzip(res.rawPayload);
    const wavs = entries.filter((e) => e.name.endsWith(".wav"));
    expect(wavs.map((e) => e.name)).toEqual([
      "Album/Duo/Bass.wav",
      "Album/Duo/Bass (2).wav",
      "Album/Secret.wav",
    ]);
    for (const w of wavs) expect(w.data.subarray(0, 4).toString("latin1")).toBe("RIFF");
    for (const e of entries) expect(e.crc).toBe(crc32(e.data) >>> 0);
    expect(t.ffmpegSlots.inUse).toBe(0);
  }, 120_000);

  it("needs download on the project: not in the reduced view, hidden from outsiders", async () => {
    // Song grants only: no project role, so no export (and no project documents).
    const reduced = await call(
      t,
      getProjectExportPreview,
      { params: { id: projectId }, query: { format: "opus" } },
      cookies.gita,
    );
    expect(reduced.statusCode).toBe(403);
    expect((await download("opus", "gita")).statusCode).toBe(403);
    expect((await download("flac", "olga")).statusCode).toBe(404);
  });

  it("refuses when the project's download policy forbids the user", async () => {
    t.db.$client
      .prepare("UPDATE projects SET download_policy = 'editors' WHERE id = ?")
      .run(projectId);
    try {
      expect((await download("flac", "petr")).statusCode).toBe(403);
    } finally {
      t.db.$client
        .prepare("UPDATE projects SET download_policy = 'all' WHERE id = ?")
        .run(projectId);
    }
  });

  it("allows five exports per minute per user", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await download("opus", "eva")).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
  }, 60_000);
});
