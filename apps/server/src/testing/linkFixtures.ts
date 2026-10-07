import fs from "node:fs/promises";
import { generateFixtures, matrix, TONE_FILE } from "@bandroom/fixtures";
import {
  API_PREFIX,
  ApiErrorSchema,
  createProject,
  createProjectLink,
  createSong,
  createSongLink,
  listSongTracks,
  PublicLinkSchema,
  setProjectGrant,
  TrackSchema,
  UploadResultSchema,
  type CreateLink,
  type PublicLink,
  type Track,
} from "@bandroom/shared";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, expect } from "vitest";
import { z } from "zod";
import { LINK_COOKIE } from "../http/linkAuth";
import {
  call,
  createTestApp,
  loginAs,
  runQueuedJobs,
  seedUser,
  tusUpload,
  type TestApp,
} from "./testApp";

/**
 * Fixtures and visitor helpers shared by the public link tests (`routes/links-*.test.ts`). The
 * `let` exports are live bindings: each test file calls `setupLinkFixtures()` and reads them.
 */

export let t: TestApp;
export let admin: string;
export let editor: string;
export let editorId: string;
export let projectId: string;
export let songId: string;
export let song2Id: string;
export let otherSongId: string;
export let bassV1: string;
export let bassV2: string;
export let mixV1: string;
export let adminTracks: Track[];
export let otherTrack: Track;

export const tokenOf = (l: PublicLink) => l.url.split("/l/")[1] ?? "";
export const cookieOf = (res: LightMyRequestResponse) => {
  const c = res.cookies.find((x) => x.name === LINK_COOKIE);
  return c ? `${c.name}=${c.value}` : undefined;
};
export const codeOf = (res: LightMyRequestResponse) =>
  res.statusCode >= 400 ? ApiErrorSchema.parse(res.json()).code : "ok";

/** A visitor request below `/l/:token`. */
export function visit(
  token: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  opts: {
    cookie?: string;
    body?: unknown;
    headers?: Record<string, string>;
    remoteAddress?: string;
  } = {},
) {
  return t.app.inject({
    method,
    ...(opts.remoteAddress && { remoteAddress: opts.remoteAddress }),
    url: `${t.basePath}${API_PREFIX}/l/${token}${path}`,
    headers: {
      "x-requested-with": "bandroom",
      ...(opts.cookie && { cookie: opts.cookie }),
      ...opts.headers,
    },
    ...(opts.body !== undefined && { payload: opts.body as Record<string, unknown> }),
  });
}

export async function makeLink(
  body: Partial<CreateLink> & { scopeType: CreateLink["scopeType"] },
  cookie = editor,
  target = songId,
): Promise<PublicLink> {
  const full = {
    label: "For mastering",
    versions: "current-only",
    expiresAt: null,
    allowDownload: false,
    allowComments: false,
    showComments: false,
    ...body,
  } as const;
  const res =
    full.scopeType === "project"
      ? await call(t, createProjectLink, { params: { id: projectId }, body: full }, cookie)
      : await call(t, createSongLink, { params: { id: target }, body: full }, cookie);
  if (res.statusCode !== 200) throw new Error(`create link: ${res.statusCode} ${res.body}`);
  return PublicLinkSchema.parse(res.json<{ link: unknown }>().link);
}

/** Opens a link without a password and returns the visitor's cookie. */
export async function openAs(link: PublicLink): Promise<string> {
  const res = await visit(tokenOf(link), "POST", "/open");
  expect(res.statusCode).toBe(200);
  const cookie = cookieOf(res);
  if (!cookie) throw new Error("no link cookie");
  return cookie;
}

export const tracksVia = async (token: string, cookie: string, id = songId) =>
  z
    .object({ tracks: z.array(TrackSchema) })
    .parse((await visit(token, "GET", `/songs/${id}/tracks`, { cookie })).json()).tracks;

export const blob = (token: string, cookie: string, hash: string) =>
  visit(token, "GET", `/blobs/${hash}`, { cookie });

async function runAllJobsNow() {
  for (let pass = 0; pass < 3; pass++) {
    t.db.$client.prepare("UPDATE jobs SET run_after = 0 WHERE status = 'queued'").run();
    if ((await runQueuedJobs(t)).length === 0) return;
  }
}

/**
 * Registers the shared setup of the link tests: an admin, an editor ("eda") with editor rights on
 * "Album", songs "Song" (Bass v1/v2, Mix) and "Second" (Drums), and "Elsewhere" (Keys) in another
 * project, all ingested. The exported bindings are filled in before the first test.
 */
export function setupLinkFixtures(): void {
  beforeAll(async () => {
    await generateFixtures();
    t = await createTestApp();
    await seedUser(t, "boss", "admin");
    editorId = (await seedUser(t, "eda", "member")).id;
    await seedUser(t, "petr", "member");
    admin = await loginAs(t, "boss");
    editor = await loginAs(t, "eda");
    projectId = (await call(t, createProject, { body: { name: "Album" } }, admin)).json<{
      project: { id: string };
    }>().project.id;
    await call(
      t,
      setProjectGrant,
      { params: { id: projectId, userId: editorId }, body: { role: "editor" } },
      admin,
    );
    const newSong = async (pid: string, title: string) =>
      (await call(t, createSong, { params: { id: pid }, body: { title } }, admin)).json<{
        song: { id: string };
      }>().song.id;
    songId = await newSong(projectId, "Song");
    song2Id = await newSong(projectId, "Second");
    const files = matrix();
    const file = async (name: string) =>
      fs.readFile(files.find((x) => x.name === name)?.file ?? TONE_FILE());
    const bass = await tusUpload(t, admin, await fs.readFile(TONE_FILE()), "Bass.wav", {
      type: "newTrack",
      songId,
      name: "Bass",
    });
    const bassTrack = UploadResultSchema.parse(JSON.parse(bass.body)).trackId ?? "";
    await tusUpload(t, admin, await file("imp_48000_s16_mono"), "Bass2.wav", {
      type: "newVersion",
      trackId: bassTrack,
    });
    await tusUpload(t, admin, await file("imp_48000_s24_stereo"), "Mix.wav", {
      type: "newTrack",
      songId,
      name: "Mix",
    });
    await tusUpload(t, admin, await file("imp_44100_s16_stereo"), "Drums.wav", {
      type: "newTrack",
      songId: song2Id,
      name: "Drums",
    });
    const other = (await call(t, createProject, { body: { name: "Other" } }, admin)).json<{
      project: { id: string };
    }>().project.id;
    otherSongId = await newSong(other, "Elsewhere");
    await tusUpload(t, admin, await file("imp_48000_f32_stereo"), "Keys.wav", {
      type: "newTrack",
      songId: otherSongId,
      name: "Keys",
    });
    await runAllJobsNow();
    const list = await call(t, listSongTracks, { params: { id: songId } }, admin);
    adminTracks = z.object({ tracks: z.array(TrackSchema) }).parse(list.json()).tracks;
    const bassT = adminTracks.find((x) => x.name === "Bass");
    const mixT = adminTracks.find((x) => x.name === "Mix");
    bassV2 = bassT?.current?.id ?? "";
    mixV1 = mixT?.current?.id ?? "";
    bassV1 = (
      t.db.$client
        .prepare("SELECT id FROM track_versions WHERE track_id = ? AND number = 1")
        .get(bassT?.id ?? "") as { id: string }
    ).id;
    otherTrack = z
      .object({ tracks: z.array(TrackSchema) })
      .parse((await call(t, listSongTracks, { params: { id: otherSongId } }, admin)).json())
      .tracks[0] as Track;
  }, 600_000);

  afterAll(async () => {
    await t.close();
  });
}

export const hashOfVersion = (versionId: string) =>
  (
    t.db.$client
      .prepare(
        `SELECT av.blob_hash AS h FROM asset_variants av JOIN track_versions v ON v.asset_id = av.asset_id
         WHERE v.id = ? AND av.variant = 'opus'`,
      )
      .get(versionId) as { h: string }
  ).h;
