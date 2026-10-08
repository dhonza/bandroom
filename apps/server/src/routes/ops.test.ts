import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { BWF_FILE } from "@bandroom/fixtures";
import { logFilePath } from "@bandroom/server-core";
import {
  ApiErrorSchema,
  getAdminEvents,
  getAdminJobs,
  getAdminLogs,
  getAdminStorage,
  getAdminSystem,
  getAdminUploads,
  type AdminEvent,
  type AdminJob,
  type AdminLogRecord,
  type AdminSystem,
  type AdminUpload,
} from "@bandroom/shared";
import type { LightMyRequestResponse } from "fastify";
import { beforeAll, describe, expect, it } from "vitest";
import { call, callWithKey, keyFor, tusUpload } from "../testing/testApp";
import { admin, member, setupUploadFixtures, songId, t } from "../testing/uploadFixtures";
import { readStatusFile } from "./ops";

setupUploadFixtures();

const codeOf = (res: LightMyRequestResponse) =>
  res.statusCode >= 400 ? ApiErrorSchema.parse(res.json()).code : "ok";

let bossId = "";
beforeAll(async () => {
  bossId = (
    t.db.$client.prepare("SELECT id FROM users WHERE username = 'boss'").get() as {
      id: string;
    }
  ).id;
  const data = await fsp.readFile(BWF_FILE());
  await tusUpload(t, member, data, "Ops_Bass.wav", { type: "newTrack", songId, name: "Ops bass" });
});

describe("ops read endpoints (SPEC §29.6)", () => {
  it("reports the system, including status files", async () => {
    fs.mkdirSync(path.join(t.dataDir, "ops"), { recursive: true });
    fs.writeFileSync(
      path.join(t.dataDir, "ops", "host-status.json"),
      JSON.stringify({ ts: 1, containers: [] }),
    );
    const res = await call(t, getAdminSystem, {}, admin);
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminSystem>();
    expect(body.node).toBe(process.version);
    expect(body.blobs.count).toBeGreaterThan(0);
    expect(body.hostStatus).toEqual({ ts: 1, containers: [] });
    expect(body.backup).toBeNull();
    expect(JSON.stringify(body)).not.toContain(t.config.appSecret);
    expect(codeOf(await call(t, getAdminSystem, {}, member))).toBe("FORBIDDEN");
  });

  it("reads status files defensively", () => {
    const f = path.join(t.dataDir, "x.json");
    fs.writeFileSync(f, "[1]");
    expect(readStatusFile(f)).toBeNull();
    fs.writeFileSync(f, "nope");
    expect(readStatusFile(f)).toBeNull();
    fs.writeFileSync(f, "x".repeat(300 * 1024));
    expect(readStatusFile(f)).toBeNull();
    expect(readStatusFile(t.dataDir)).toBeNull();
  });

  it("lists jobs with counts and only id refs from payloads", async () => {
    const res = await call(t, getAdminJobs, { query: { status: "queued" } }, admin);
    const body = res.json<{ jobs: AdminJob[]; counts: Record<string, number> }>();
    expect(body.jobs.length).toBeGreaterThan(0);
    expect(body.counts.queued).toBe(body.jobs.length);
    const job = body.jobs[0];
    expect(job?.type).toBe("audio.ingest");
    expect(job?.refs.assetId).toBeTruthy();
    for (const v of Object.values(job?.refs ?? {})) expect(typeof v).toBe("string");
    const typed = await call(t, getAdminJobs, { query: { type: "nope", before: "1" } }, admin);
    expect(typed.json<{ jobs: AdminJob[] }>().jobs).toEqual([]);
  });

  it("pages through events with filters", async () => {
    const first = (await call(t, getAdminEvents, { query: { limit: "1" } }, admin)).json<{
      events: AdminEvent[];
      nextCursor: string | null;
    }>();
    expect(first.events).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = (
      await call(
        t,
        getAdminEvents,
        { query: { limit: "1", cursor: first.nextCursor ?? "" } },
        admin,
      )
    ).json<{ events: AdminEvent[] }>();
    expect((second.events[0]?.id ?? "") < (first.events[0]?.id ?? "")).toBe(true);
    const uploads = (
      await call(
        t,
        getAdminEvents,
        { query: { action: "version.uploaded", since: "0", until: String(Date.now() + 1000) } },
        admin,
      )
    ).json<{ events: AdminEvent[]; nextCursor: string | null }>();
    expect(uploads.events.length).toBeGreaterThan(0);
    expect(uploads.events[0]?.actorName).toBe("Petr");
    expect(uploads.nextCursor).toBeNull();
    expect(JSON.stringify(uploads.events[0]?.details)).toContain('"trackId"');
  });

  it("shows storage per user and recent uploads", async () => {
    const storage = (await call(t, getAdminStorage, {}, admin)).json<{
      users: { username: string; usedBytes: number }[];
      totals: { blobBytes: number };
    }>();
    expect(storage.users.find((u) => u.username === "petr")?.usedBytes).toBeGreaterThan(0);
    expect(storage.totals.blobBytes).toBeGreaterThan(0);
    const uploads = (await call(t, getAdminUploads, { query: { hours: "1" } }, admin)).json<{
      uploads: AdminUpload[];
    }>();
    expect(uploads.uploads[0]).toMatchObject({
      trackName: "Ops bass",
      songTitle: "Song",
      projectName: "Album",
      uploader: "petr",
      filename: "Ops_Bass.wav",
      deleted: false,
    });
  });

  it("reads the warn+ log files", async () => {
    const file = logFilePath(t.dataDir, "worker");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        { level: 40, time: 10, msg: "warned" },
        { level: 50, time: 20, msg: "failed" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    fs.writeFileSync(
      logFilePath(t.dataDir, "app"),
      `${JSON.stringify({ level: 60, time: 15, msg: "app fatal" })}\n`,
    );
    const all = (await call(t, getAdminLogs, {}, admin)).json<{ records: AdminLogRecord[] }>();
    expect(all.records.map((r) => `${r.source}:${r.msg}`)).toEqual([
      "worker:warned",
      "app:app fatal",
      "worker:failed",
    ]);
    const errors = (
      await call(
        t,
        getAdminLogs,
        { query: { source: "worker", level: "error", since: "1" } },
        admin,
      )
    ).json<{ records: AdminLogRecord[] }>();
    expect(errors.records.map((r) => r.msg)).toEqual(["failed"]);
  });

  it("is open to admin keys with admin:read only", async () => {
    const adminRead = keyFor(t, bossId, ["admin:read"]);
    expect(codeOf(await callWithKey(t, getAdminSystem, {}, adminRead))).toBe("ok");
    const contentKey = keyFor(t, bossId, ["read", "write"]);
    expect(codeOf(await callWithKey(t, getAdminJobs, {}, contentKey))).toBe("API_KEY_SCOPE");
  });
});
