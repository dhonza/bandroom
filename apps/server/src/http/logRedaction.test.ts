import { Writable } from "node:stream";
import { loggerOptions, redactUrl } from "@bandroom/server-core";
import Fastify from "fastify";
import { pino } from "pino";
import { describe, expect, it } from "vitest";

const TOKEN = "Zk3v9QwErTyUiOpAsDfGhJ";

describe("redactUrl", () => {
  it.each([
    [`/l/${TOKEN}`, "/l/[redacted]"],
    [`/bandroom/l/${TOKEN}/songs/abc`, "/bandroom/l/[redacted]/songs/abc"],
    [`/api/v1/l/${TOKEN}/blobs/ff00?x=1`, "/api/v1/l/[redacted]/blobs/ff00?x=1"],
    [`/api/v1/invites/${TOKEN}/accept`, "/api/v1/invites/[redacted]/accept"],
    [`/invite/${TOKEN}`, "/invite/[redacted]"],
    [`/reset/${TOKEN}#x`, "/reset/[redacted]#x"],
    [`/api/v1/password-resets/${TOKEN}`, "/api/v1/password-resets/[redacted]"],
    ["/api/v1/songs/0190/comments", "/api/v1/songs/0190/comments"],
    ["/library", "/library"],
  ])("%s → %s", (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });
});

describe("Fastify request logging", () => {
  it("never writes link tokens, cookies or authorization to the log", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = pino(loggerOptions({ logLevel: "info" }, "test"), stream);
    const app = Fastify({ loggerInstance: logger });
    app.get("/api/v1/l/:token/songs/:id", () => Promise.resolve({ ok: true }));
    app.get("/l/:token", () => Promise.resolve("page"));
    await app.ready();

    await app.inject({
      url: `/api/v1/l/${TOKEN}/songs/s1`,
      headers: { cookie: "bandroom_session=secret-cookie", authorization: "Bearer secret-auth" },
    });
    await app.inject({ url: `/l/${TOKEN}?ref=chat` });
    await app.close();

    const log = lines.join("");
    expect(log).toContain("/api/v1/l/[redacted]/songs/s1");
    expect(log).toContain("/l/[redacted]?ref=chat");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain("secret-cookie");
    expect(log).not.toContain("secret-auth");
  });
});
