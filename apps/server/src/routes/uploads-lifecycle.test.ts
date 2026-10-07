import fs from "node:fs/promises";
import path from "node:path";
import { API_PREFIX, ApiErrorSchema } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { loginAs, seedUser, tusUpload } from "../testing/testApp";
import { admin, member, setupUploadFixtures, songId, t } from "../testing/uploadFixtures";
import { cleanUpExpiredUploads, UPLOAD_CREATE_LIMIT, uploadsDirectory } from "./uploads";

setupUploadFixtures();

// One file: the creation rate limit runs after other uploads, as before the split. On a fresh
// app its burst ends the test while tus still creates its store directory.

describe("upload finish failures (review L10)", () => {
  const dir = () => uploadsDirectory(t.config.tmpDir);
  const state = async () => ({
    files: (await fs.readdir(dir()).catch(() => [])).sort(),
    open: (
      t.db.$client
        .prepare("SELECT COUNT(*) AS n FROM upload_sessions WHERE completed_at IS NULL")
        .get() as { n: number }
    ).n,
  });
  const target = () => ({ type: "newTrack", songId, name: "Doomed" });

  it("drops the session and its files when the commit fails", async () => {
    const before = await state();
    t.db.$client.exec(
      "CREATE TRIGGER fail_asset BEFORE INSERT ON assets BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    let res: Awaited<ReturnType<typeof tusUpload>>;
    try {
      res = await tusUpload(t, admin, Buffer.from("RIFF-not-really"), "d.wav", target());
    } finally {
      t.db.$client.exec("DROP TRIGGER fail_asset");
    }
    expect(res.createStatus).toBe(201);
    expect(res.status).toBe(500);
    expect(ApiErrorSchema.parse(JSON.parse(res.body)).code).toBe("INTERNAL");
    expect(await state()).toEqual(before);
  });

  it("answers a coded error and cleans up when the stored target no longer parses", async () => {
    const before = await state();
    const base = `${t.basePath}${API_PREFIX}/uploads`;
    const headers = { cookie: admin, "x-requested-with": "bandroom", "tus-resumable": "1.0.0" };
    const b64 = (v: string) => Buffer.from(v).toString("base64");
    const create = await t.app.inject({
      method: "POST",
      url: base,
      headers: {
        ...headers,
        "upload-length": "3",
        "upload-metadata": `filename ${b64("x.wav")},target ${b64(JSON.stringify(target()))}`,
      },
    });
    expect(create.statusCode).toBe(201);
    const location = String(create.headers.location);
    const id = location.split("/").at(-1) ?? "";
    t.db.$client.prepare("UPDATE upload_sessions SET target = ? WHERE id = ?").run("{}", id);
    const patch = await t.app.inject({
      method: "PATCH",
      url: location,
      headers: {
        ...headers,
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
      },
      payload: Buffer.from("abc"),
    });
    expect(patch.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(patch.json()).code).toBe("VALIDATION_FAILED");
    expect(await state()).toEqual(before);
  });
});

describe("upload creation rate limit", () => {
  it("limits creations per user but never the chunk requests", async () => {
    await seedUser(t, "spammer", "member");
    const cookie = await loginAs(t, "spammer");
    const headers = {
      cookie,
      "x-requested-with": "bandroom",
      "tus-resumable": "1.0.0",
    };
    const base = `${t.basePath}${API_PREFIX}/uploads`;
    const create = () =>
      t.app.inject({ method: "POST", url: base, headers: { ...headers, "upload-length": "1" } });
    for (let i = 0; i < UPLOAD_CREATE_LIMIT.max; i++) {
      expect((await create()).statusCode).not.toBe(429);
    }
    expect((await create()).statusCode).toBe(429);
    const patch = await t.app.inject({
      method: "PATCH",
      url: `${base}/missing`,
      headers: {
        ...headers,
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
      },
      payload: Buffer.from("x"),
    });
    expect(patch.statusCode).not.toBe(429);
    // Another user is not affected.
    const other = await tusUpload(t, admin, Buffer.from("x"), "a.wav", { type: "x" });
    expect(other.createStatus).not.toBe(429);
  });
});

describe("abandoned uploads (SPEC §5.1)", () => {
  const create = async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers: {
        cookie: member,
        "x-requested-with": "bandroom",
        "tus-resumable": "1.0.0",
        "upload-length": "10",
        "upload-metadata": `filename ${Buffer.from("a.wav").toString("base64")},target ${Buffer.from(JSON.stringify({ type: "newTrack", songId, name: "A" })).toString("base64")}`,
      },
    });
    expect(res.statusCode).toBe(201);
    return String(res.headers.location).split("/").pop() ?? "";
  };

  it("deletes files of unfinished uploads older than 24 h, keeps fresh ones", async () => {
    const dir = uploadsDirectory(t.config.tmpDir);
    const old = await create();
    const fresh = await create();
    const meta = path.join(dir, `${old}.json`);
    const info = JSON.parse(await fs.readFile(meta, "utf8")) as { creation_date: string };
    info.creation_date = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await fs.writeFile(meta, JSON.stringify(info));

    expect(await cleanUpExpiredUploads(dir)).toBe(1);
    const left = await fs.readdir(dir);
    expect(left).not.toContain(old);
    expect(left).not.toContain(`${old}.json`);
    expect(left).toContain(fresh);
    expect(left).toContain(`${fresh}.json`);
    // Finished uploads were moved into blob storage, so nothing of theirs is left here.
    expect(left.every((f) => !f.endsWith(".tmp"))).toBe(true);
    expect(await cleanUpExpiredUploads(path.join(dir, "missing"))).toBe(0);
  });
});
