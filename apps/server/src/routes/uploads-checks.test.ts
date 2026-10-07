import http from "node:http";
import { getUsage, listEvents, reservedUploadBytes } from "@bandroom/server-core";
import { ApiErrorSchema, setProjectGrant, UploadResultSchema } from "@bandroom/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { call, loginAs, runQueuedJobs, seedUser, tusUpload } from "../testing/testApp";
import {
  admin,
  member,
  memberId,
  projectId,
  setupUploadFixtures,
  songId,
  t,
  tracksOf,
} from "../testing/uploadFixtures";

setupUploadFixtures();

// The member already stores a file, as after the ingest tests these checks used to follow: the
// quota checks below expect usage above their limits.
beforeAll(async () => {
  const prior = await tusUpload(t, member, Buffer.alloc(2000), "Prior.wav", {
    type: "newTrack",
    songId,
    name: "Prior",
  });
  expect(prior.status).toBe(200);
});

describe("upload checks (SPEC §5.1, §15.1)", () => {
  const small = Buffer.from("RIFF....WAVEfmt ");

  it("requires upload permission on the target", async () => {
    await seedUser(t, "viewer1", "member");
    const viewer = await loginAs(t, "viewer1");
    const users = t.db.$client.prepare("SELECT id FROM users WHERE username = 'viewer1'").get() as {
      id: string;
    };
    await call(
      t,
      setProjectGrant,
      { params: { id: projectId, userId: users.id }, body: { role: "viewer" } },
      admin,
    );
    const res = await tusUpload(t, viewer, small, "x.wav", { type: "newTrack", songId, name: "X" });
    expect(res.createStatus).toBe(403);
    expect(ApiErrorSchema.parse(JSON.parse(res.body)).code).toBe("FORBIDDEN");
  });

  it("rejects anonymous uploads and invalid targets", async () => {
    const anon = await t.app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers: { "x-requested-with": "bandroom", "tus-resumable": "1.0.0", "upload-length": "10" },
    });
    expect(anon.statusCode).toBe(401);
    const bad = await tusUpload(t, member, small, "x.wav", { type: "nope" });
    expect(ApiErrorSchema.parse(JSON.parse(bad.body)).code).toBe("VALIDATION_FAILED");
  });

  it("enforces the quota with declared size × 1.1 and names the admins", async () => {
    t.db.$client.prepare("UPDATE users SET quota_bytes = ? WHERE id = ?").run(1000, memberId);
    const res = await tusUpload(t, member, Buffer.alloc(950), "big.wav", {
      type: "newTrack",
      songId,
      name: "Big",
    });
    expect(res.createStatus).toBe(413);
    const err = ApiErrorSchema.parse(JSON.parse(res.body));
    expect(err.code).toBe("QUOTA_EXCEEDED");
    expect(err.params).toMatchObject({ remainingBytes: 0, admins: "Boss" });
    t.db.$client.prepare("UPDATE users SET quota_bytes = -1 WHERE id = ?").run(memberId);
    expect(
      (await tusUpload(t, member, small, "ok.wav", { type: "newTrack", songId, name: "Unlimited" }))
        .status,
    ).toBe(200);
  });

  it("counts unfinished uploads against the quota and re-checks it at the end (review M8)", async () => {
    const tus = (
      method: string,
      url: string,
      headers: Record<string, string> = {},
      payload?: Buffer,
    ) =>
      t.app.inject({
        method: method as "POST",
        url,
        headers: {
          cookie: member,
          "x-requested-with": "bandroom",
          "tus-resumable": "1.0.0",
          ...headers,
        },
        ...(payload && { payload }),
      });
    const create = (name: string, length: number) =>
      tus("POST", "/api/v1/uploads", {
        "upload-length": String(length),
        "upload-metadata": `filename ${Buffer.from(`${name}.wav`).toString("base64")},target ${Buffer.from(JSON.stringify({ type: "newTrack", songId, name })).toString("base64")}`,
      });
    const setQuota = (bytes: number) =>
      t.db.$client.prepare("UPDATE users SET quota_bytes = ? WHERE id = ?").run(bytes, memberId);
    setQuota(getUsage(t.db, memberId) + 2000);
    try {
      const a = await create("ParallelA", 1000);
      expect(a.statusCode).toBe(201);
      const b = await create("ParallelB", 1000);
      expect(b.statusCode).toBe(413);
      expect(ApiErrorSchema.parse(b.json()).code).toBe("QUOTA_EXCEEDED");
      // Cancelling A releases its reservation (over a real socket: this tus DELETE never
      // completes through inject()).
      const bound = t.app.server.address();
      const address =
        bound && typeof bound === "object"
          ? `http://127.0.0.1:${String(bound.port)}`
          : await t.app.listen({ host: "127.0.0.1", port: 0 });
      const del = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const r = http.request(
          `${address}${String(a.headers.location)}`,
          {
            method: "DELETE",
            headers: { cookie: member, "x-requested-with": "bandroom", "tus-resumable": "1.0.0" },
          },
          (res) => {
            let body = "";
            res.on("data", (c: Buffer) => (body += c.toString()));
            res.on("end", () => {
              resolve({ statusCode: res.statusCode ?? 0, body });
            });
          },
        );
        r.on("error", reject);
        r.end();
      });
      expect(del.statusCode).toBe(204);
      const c = await create("ParallelC", 1000);
      expect(c.statusCode).toBe(201);
      // The quota shrinks before C completes: the finished upload is refused and forgotten.
      setQuota(getUsage(t.db, memberId) + 500);
      const done = await tus(
        "PATCH",
        String(c.headers.location),
        { "upload-offset": "0", "content-type": "application/offset+octet-stream" },
        Buffer.alloc(1000),
      );
      expect(done.statusCode).toBe(413);
      expect(ApiErrorSchema.parse(JSON.parse(done.body)).code).toBe("QUOTA_EXCEEDED");
      expect(reservedUploadBytes(t.db, memberId)).toBe(0);
      expect((await tracksOf(member)).some((x) => x.name === "ParallelC")).toBe(false);
    } finally {
      setQuota(-1);
    }
  });

  it("adds no track when the upload event cannot be written (review M14)", async () => {
    t.db.$client.exec(`CREATE TEMP TRIGGER no_upload_events BEFORE INSERT ON events
      WHEN NEW.action = 'version.uploaded'
      BEGIN SELECT RAISE(ABORT, 'event log unavailable'); END`);
    try {
      const res = await tusUpload(t, member, small, "ghost.wav", {
        type: "newTrack",
        songId,
        name: "Ghost",
      });
      expect(res.status).toBe(500);
      expect((await tracksOf(member)).some((x) => x.name === "Ghost")).toBe(false);
    } finally {
      t.db.$client.exec("DROP TRIGGER no_upload_events");
    }
  });

  it("marks unreadable uploads failed", async () => {
    await runQueuedJobs(t);
    const bad = (await tracksOf(member)).find((x) => x.name === "Unlimited");
    expect(bad?.current).toMatchObject({ status: "failed" });
    expect(bad?.current?.error).toBeTruthy();
  });

  it("does not let another user resume someone's upload", async () => {
    const create = await t.app.inject({
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
    const location = String(create.headers.location);
    const head = await t.app.inject({
      method: "HEAD",
      url: location,
      headers: { cookie: admin, "tus-resumable": "1.0.0" },
    });
    expect(head.statusCode).toBe(404);
    const own = await t.app.inject({
      method: "HEAD",
      url: location,
      headers: { cookie: member, "tus-resumable": "1.0.0" },
    });
    expect(own.statusCode).toBe(200);
    expect(own.headers["upload-offset"]).toBe("0");
  });

  it("records the client address Fastify resolved, not a spoofed X-Forwarded-For (review M9)", async () => {
    const res = await tusUpload(
      t,
      member,
      small,
      "spoof.wav",
      { type: "newTrack", songId, name: "Spoof" },
      { "x-forwarded-for": "6.6.6.6" },
    );
    expect(res.status).toBe(200);
    const { trackVersionId } = UploadResultSchema.parse(JSON.parse(res.body));
    const [event] = listEvents(t.db, { action: "version.uploaded" }).filter(
      (e) => e.targetId === trackVersionId,
    );
    expect(event?.ip).toBe("127.0.0.1"); // TRUST_PROXY is off in tests
  });
});
