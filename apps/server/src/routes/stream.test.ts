import http from "node:http";
import { API_PREFIX, adminUpdateUser, logout } from "@bandroom/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProjectRow,
  createSongRow,
  getUserById,
  setProjectGrantRow,
} from "@bandroom/server-core";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "../testing/testApp";
import { makeFilter } from "./stream";

let t: TestApp;
let address: string;
beforeEach(async () => {
  t = await createTestApp();
  address = await t.app.listen({ host: "127.0.0.1", port: 0 });
});
afterEach(async () => {
  await t.close();
});

interface OpenStream {
  res: http.IncomingMessage;
  req: http.ClientRequest;
  /** Resolves when the server ends or drops the stream. */
  ended: Promise<void>;
}

function openStream(cookie: string, opts: { read?: boolean } = {}): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${address}${t.basePath}${API_PREFIX}/stream`,
      { headers: { cookie } },
      (res) => {
        const ended = new Promise<void>((done) => {
          res.on("close", done);
          res.on("end", done);
          res.on("error", () => {
            done();
          });
        });
        if (opts.read === false) res.pause();
        else res.resume();
        resolve({ res, req, ended });
      },
    );
    req.on("error", reject);
  });
}

const within = <T>(p: Promise<T>, ms = 5000) =>
  Promise.race([
    p,
    new Promise<never>((_r, reject) =>
      setTimeout(() => {
        reject(new Error("timed out"));
      }, ms),
    ),
  ]);

describe("GET /stream session checks (review M1)", () => {
  it("ends the stream on logout", async () => {
    await seedUser(t, "alice");
    const cookie = await loginAs(t, "alice");
    const s = await openStream(cookie);
    expect(s.res.statusCode).toBe(200);
    expect(t.hub.size).toBe(1);
    await call(t, logout, {}, cookie);
    await within(s.ended);
    expect(t.hub.size).toBe(0);
  });

  it("ends the streams of a user an admin disables or demotes", async () => {
    await seedUser(t, "root", "admin");
    const bob = await seedUser(t, "bob", "member");
    const carol = await seedUser(t, "carol", "member");
    const adminCookie = await loginAs(t, "root");
    const bobStream = await openStream(await loginAs(t, "bob"));
    const carolStream = await openStream(await loginAs(t, "carol"));
    const disabled = await call(
      t,
      adminUpdateUser,
      { params: { id: bob.id }, body: { disabled: true } },
      adminCookie,
    );
    expect(disabled.statusCode).toBe(200);
    await within(bobStream.ended);
    const demoted = await call(
      t,
      adminUpdateUser,
      { params: { id: carol.id }, body: { globalRole: "guest" } },
      adminCookie,
    );
    expect(demoted.statusCode).toBe(200);
    await within(carolStream.ended);
  });

  it("keeps other users' streams open", async () => {
    await seedUser(t, "alice");
    await seedUser(t, "bob");
    const alice = await loginAs(t, "alice");
    const bobStream = await openStream(await loginAs(t, "bob"));
    let bobEnded = false;
    void bobStream.ended.then(() => (bobEnded = true));
    await call(t, logout, {}, alice);
    await new Promise((r) => setTimeout(r, 50));
    expect(bobEnded).toBe(false);
    expect(t.hub.size).toBe(1);
  });
});

describe("GET /stream limits (review M2, L12)", () => {
  it("closes the oldest stream beyond 10 per user", async () => {
    await seedUser(t, "alice");
    const cookie = await loginAs(t, "alice");
    const first = await openStream(cookie);
    for (let i = 0; i < 10; i++) await openStream(cookie);
    await within(first.ended);
    expect(t.hub.size).toBe(10);
  });

  it("drops a client that stops reading instead of buffering without bound", async () => {
    const alice = await seedUser(t, "alice");
    const s = await openStream(await loginAs(t, "alice"), { read: false });
    const big = "x".repeat(64 * 1024);
    for (let i = 0; i < 2000 && t.hub.size > 0; i++) {
      t.hub.publish({ type: "notification.created", userId: alice.id, data: { big } });
      if (i % 50 === 0) await new Promise((r) => setImmediate(r));
    }
    expect(t.hub.size).toBe(0);
    s.req.destroy();
  });

  it("limits stream opens per user to 30 a minute", async () => {
    await seedUser(t, "alice");
    await seedUser(t, "bob");
    const alice = await loginAs(t, "alice");
    for (let i = 0; i < 30; i++) expect((await openStream(alice)).res.statusCode).toBe(200);
    expect((await openStream(alice)).res.statusCode).toBe(429);
    expect((await openStream(await loginAs(t, "bob"))).res.statusCode).toBe(200);
  });

  it("ends open streams when the server closes", async () => {
    await seedUser(t, "alice");
    const s = await openStream(await loginAs(t, "alice"));
    await within(t.app.close());
    await within(s.ended);
  });
});

describe("event filter (review L13)", () => {
  it("sends link changes only to users who manage links", async () => {
    const boss = await seedUser(t, "boss", "admin");
    const viewer = await seedUser(t, "vera", "member");
    const editor = await seedUser(t, "eda", "member");
    const project = createProjectRow(t.db, { name: "P", createdBy: boss.id });
    const song = createSongRow(t.db, { projectId: project.id, title: "S", createdBy: boss.id });
    setProjectGrantRow(t.db, project.id, viewer.id, "viewer", boss.id);
    setProjectGrantRow(t.db, project.id, editor.id, "editor", boss.id);
    const [v, e] = [viewer.id, editor.id].map((id) => {
      const u = getUserById(t.db, id);
      if (!u) throw new Error("user missing");
      return makeFilter(t, u);
    });
    if (!v || !e) throw new Error("filters missing");
    const onSong = { projectId: project.id, songId: song.id, data: {} };
    const onProject = { projectId: project.id, songId: null, data: {} };
    for (const scope of [onSong, onProject]) {
      expect(v({ ...scope, type: "link.changed" })).toBe(false);
      expect(e({ ...scope, type: "link.changed" })).toBe(true);
      // The cache keys on the capability: plain events still reach viewers.
      expect(v({ ...scope, type: "marker.changed" })).toBe(true);
    }
  });
});
