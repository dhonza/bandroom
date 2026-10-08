import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CappedLogFile, logFilePath, readLogRecords } from "./logFile";
import { createLogger } from "./logger";
import { makeTempDir } from "./testing/tempDir";

let tmp: ReturnType<typeof makeTempDir>;
beforeEach(() => {
  tmp = makeTempDir();
});
afterEach(() => {
  tmp.cleanup();
});

const line = (level: number, msg: string, time = 1000) =>
  `${JSON.stringify({ level, time, msg })}\n`;

describe("CappedLogFile", () => {
  it("rotates at the cap, keeping one previous file", () => {
    const file = logFilePath(tmp.dir, "app");
    const log = new CappedLogFile(file, 100);
    for (let i = 0; i < 10; i++) log.write(line(40, `m${i}`, i));
    log.close();
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.statSync(file).size).toBeLessThan(100);
    expect(fs.statSync(`${file}.1`).size).toBeLessThan(200);
    const records = readLogRecords(file);
    expect(records.at(-1)?.msg).toBe("m9");
    // Older rotations are gone.
    expect(records.length).toBeLessThan(10);
  });

  it("never throws when the file cannot be written", () => {
    const blocker = path.join(tmp.dir, "blocker");
    fs.writeFileSync(blocker, "");
    const log = new CappedLogFile(path.join(blocker, "x", "app.log"));
    expect(() => {
      log.write(line(50, "lost"));
    }).not.toThrow();
  });
});

describe("readLogRecords", () => {
  it("filters by level and time, limits and skips junk", () => {
    const file = logFilePath(tmp.dir, "worker");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.1`, line(40, "old warn", 1));
    fs.writeFileSync(
      file,
      [line(30, "info", 2), "not json\n", "42\n", line(50, "error", 3), line(60, "fatal", 4)].join(
        "",
      ) + JSON.stringify({ msg: 1 }),
    );
    expect(readLogRecords(file).map((r) => r.msg)).toEqual([
      "old warn",
      "info",
      "error",
      "fatal",
      "",
    ]);
    expect(readLogRecords(file, { minLevel: 50 }).map((r) => r.msg)).toEqual(["error", "fatal"]);
    expect(readLogRecords(file, { since: 3, minLevel: 1 }).map((r) => r.msg)).toEqual([
      "error",
      "fatal",
    ]);
    expect(readLogRecords(file, { limit: 1 }).map((r) => r.time)).toEqual([0]);
    expect(readLogRecords(path.join(tmp.dir, "missing.log"))).toEqual([]);
  });

  it("drops the partial first line of a bounded read", () => {
    const file = path.join(tmp.dir, "big.log");
    fs.writeFileSync(file, line(40, "a".repeat(100)) + line(40, "tail"));
    expect(readLogRecords(file, { maxBytes: 40 }).map((r) => r.msg)).toEqual(["tail"]);
  });
});

describe("createLogger with a file", () => {
  it("writes warn and above, redacted, to the file", async () => {
    const logger = createLogger({ logLevel: "info", dataDir: tmp.dir }, "test", "app");
    logger.info("only stdout");
    logger.warn({ body: { password: "secret" } }, "careful");
    logger.error("broken");
    await new Promise((r) => setTimeout(r, 20));
    const text = fs.readFileSync(logFilePath(tmp.dir, "app"), "utf8");
    expect(text).not.toContain("only stdout");
    expect(text).toContain("careful");
    expect(text).toContain("broken");
    expect(text).not.toContain("secret");
  });

  it("stays stdout-only without a file or when silent", () => {
    createLogger({ logLevel: "silent", dataDir: tmp.dir }, "test", "app").error("x");
    createLogger({ logLevel: "info" }, "test").warn("y");
    expect(fs.existsSync(path.join(tmp.dir, "logs"))).toBe(false);
  });
});
