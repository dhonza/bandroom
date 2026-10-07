import path from "node:path";
import { findUserByLogin, makeTempDir, openDb, verifyPassword } from "@bandroom/server-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./runCli";

let tmp: ReturnType<typeof makeTempDir>;
let out: string[];
let err: string[];
let answers: string[];
let stdin: string;

const io: CliIo = {
  out: (l) => out.push(l),
  err: (l) => err.push(l),
  prompt: () => Promise.resolve(answers.shift() ?? ""),
  readStdin: () => Promise.resolve(stdin),
};
const run = (args: string[], env: Record<string, string> = {}) =>
  runCli(args, { DATA_DIR: tmp.dir, APP_URL: "https://band.test/br", ...env }, io);

function user(username: string) {
  const db = openDb(path.join(tmp.dir, "bandroom.sqlite"));
  try {
    return findUserByLogin(db, username);
  } finally {
    db.$client.close();
  }
}

beforeEach(() => {
  tmp = makeTempDir();
  out = [];
  err = [];
  answers = [];
  stdin = "";
});
afterEach(() => {
  tmp.cleanup();
});

describe("bandroom CLI", () => {
  it("prints help and version", async () => {
    expect(await run([])).toBe(0);
    expect(out.join("\n")).toMatch(/create-admin/);
    expect(await run(["version"])).toBe(0);
    expect(out.at(-1)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("migrates and is idempotent", async () => {
    expect(await run(["migrate"])).toBe(0);
    expect(out[0]).toMatch(/Applied [1-9]\d* migration/);
    expect(await run(["migrate"])).toBe(0);
    expect(out[1]).toMatch(/Applied 0 migration/);
  });

  it("checks configuration", async () => {
    expect(await run(["config", "check"])).toBe(0);
    expect(out[0]).toContain("basePath=/br");
    expect(await run(["config", "check"], { NODE_ENV: "production", APP_URL: "" })).toBe(2);
  });

  it("creates an admin interactively", async () => {
    answers = ["Jana", "", "a-long-password", "a-long-password"];
    expect(await run(["create-admin"])).toBe(0);
    const u = user("jana");
    expect(u).toMatchObject({ globalRole: "admin", displayName: "jana" });
    expect(await verifyPassword(u?.passwordHash ?? "", "a-long-password")).toBe(true);
  });

  it("creates an admin from flags and stdin", async () => {
    stdin = "piped-password-123\n";
    expect(
      await run([
        "create-admin",
        "--username",
        "boss",
        "--display-name",
        "The Boss",
        "--password-stdin",
      ]),
    ).toBe(0);
    expect(user("boss")?.displayName).toBe("The Boss");
    expect(await verifyPassword(user("boss")?.passwordHash ?? "", "piped-password-123")).toBe(true);
  });

  it("rejects mismatched or short passwords and duplicates", async () => {
    answers = ["jana", "Jana", "a-long-password", "different-password"];
    expect(await run(["create-admin"])).toBe(1);
    expect(err.at(-1)).toMatch(/do not match/);
    stdin = "short";
    expect(
      await run(["create-admin", "--username", "x1x", "--display-name", "X", "--password-stdin"]),
    ).toBe(1);
    stdin = "long-enough-pass";
    expect(
      await run(["create-admin", "--username", "dup", "--display-name", "D", "--password-stdin"]),
    ).toBe(0);
    expect(
      await run(["create-admin", "--username", "dup", "--display-name", "D", "--password-stdin"]),
    ).toBe(1);
    expect(err.at(-1)).toMatch(/already exists/);
  });

  it("prints a reset link for a user", async () => {
    stdin = "long-enough-pass";
    await run(["create-admin", "--username", "boss", "--display-name", "B", "--password-stdin"]);
    expect(await run(["reset-link", "boss"])).toBe(0);
    expect(out.at(-1)).toMatch(/^https:\/\/band\.test\/br\/reset\/[A-Za-z0-9_-]{43}$/);
    expect(await run(["reset-link", "ghost"])).toBe(1);
    expect(await run(["reset-link"])).toBe(1);
  });

  it("rejects unknown commands and options", async () => {
    expect(await run(["frobnicate"])).toBe(1);
    expect(await run(["version", "--bogus"])).toBe(1);
  });
});
