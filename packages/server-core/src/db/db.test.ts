import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSetting, setSetting } from "../settings/registry";
import { makeTempDir } from "../testing/tempDir";
import { openDb, openSqlite, type Db } from "./connection";
import { pendingMigrationCount, runMigrations } from "./migrate";

// Migrations are owned by apps/server (SPEC §4).
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../../../apps/server/drizzle");

let tmp: ReturnType<typeof makeTempDir>;
let db: Db;

beforeEach(() => {
  tmp = makeTempDir();
  db = openDb(path.join(tmp.dir, "nested", "test.sqlite"));
});

afterEach(() => {
  db.$client.close();
  tmp.cleanup();
});

describe("database", () => {
  it("applies pragmas", () => {
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.$client.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  it("tracks pending migrations", () => {
    expect(pendingMigrationCount(db.$client, MIGRATIONS_DIR)).toBeGreaterThan(0);
    runMigrations(db, MIGRATIONS_DIR);
    expect(pendingMigrationCount(db.$client, MIGRATIONS_DIR)).toBe(0);
    runMigrations(db, MIGRATIONS_DIR); // idempotent
    expect(pendingMigrationCount(db.$client, MIGRATIONS_DIR)).toBe(0);
  });
});

/**
 * Another process (the worker) holding the write lock for `ms`: a worker thread with its own
 * connection, so the lock is released while this thread is blocked in SQLite's busy handler.
 */
async function holdWriteLock(file: string, ms: number): Promise<Worker> {
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     const Database = require(workerData.driver);
     const db = new Database(workerData.file);
     db.exec("BEGIN IMMEDIATE");
     db.prepare("INSERT INTO t (v) VALUES ('other process')").run();
     parentPort.postMessage("locked");
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.ms);
     db.exec("COMMIT");
     db.close();`,
    {
      eval: true,
      workerData: { driver: createRequire(import.meta.url).resolve("better-sqlite3"), file, ms },
    },
  );
  await new Promise<void>((resolve, reject) => {
    worker.once("message", () => {
      resolve();
    });
    worker.once("error", reject);
  });
  return worker;
}

describe("transactions across processes", () => {
  const readThenWrite = (d: Db) => {
    d.transaction(() => {
      const n = d.$client.prepare("SELECT count(*) AS n FROM t").get() as { n: number };
      d.$client.prepare("INSERT INTO t (v) VALUES (?)").run(`after ${n.n}`);
    });
  };

  it("waits for the other process's write lock instead of failing (immediate by default)", async () => {
    db.$client.exec("CREATE TABLE t (v TEXT)");
    const worker = await holdWriteLock(path.join(tmp.dir, "nested", "test.sqlite"), 300);
    readThenWrite(db);
    await new Promise((resolve) => worker.once("exit", resolve));
    // The transaction ran after the other process committed, and saw its row.
    expect(db.$client.prepare("SELECT v FROM t ORDER BY rowid").pluck().all()).toEqual([
      "other process",
      "after 1",
    ]);
  });

  it("documents why: a deferred read-then-write fails at once while the other process writes", async () => {
    db.$client.exec("CREATE TABLE t (v TEXT)");
    const worker = await holdWriteLock(path.join(tmp.dir, "nested", "test.sqlite"), 300);
    const started = Date.now();
    expect(() => {
      db.transaction(
        () => {
          db.$client.prepare("SELECT count(*) FROM t").get();
          db.$client.prepare("INSERT INTO t (v) VALUES ('mine')").run();
        },
        { behavior: "deferred" },
      );
    }).toThrow(/database is locked/);
    // No busy wait: the upgrade from reader to writer skips the busy handler.
    expect(Date.now() - started).toBeLessThan(250);
    await new Promise((resolve) => worker.once("exit", resolve));
  });

  it("keeps an explicit behavior and nests as savepoints", () => {
    const other = openSqlite(path.join(tmp.dir, "nested", "test.sqlite"));
    other.pragma("busy_timeout = 0");
    db.$client.exec("CREATE TABLE t (v TEXT)");
    // Immediate: the write lock is held from BEGIN, before any statement.
    db.transaction(() => {
      expect(() => other.prepare("INSERT INTO t (v) VALUES ('x')").run()).toThrow(/locked/);
      db.transaction(() => {
        db.$client.prepare("INSERT INTO t (v) VALUES ('nested')").run();
      });
    });
    // Deferred on request: no lock until the first write.
    db.transaction(
      () => {
        other.prepare("INSERT INTO t (v) VALUES ('other')").run();
      },
      { behavior: "deferred" },
    );
    other.close();
    expect(db.$client.prepare("SELECT v FROM t ORDER BY rowid").pluck().all()).toEqual([
      "nested",
      "other",
    ]);
  });
});

describe("settings", () => {
  beforeEach(() => {
    runMigrations(db, MIGRATIONS_DIR);
  });

  it("returns defaults when unset", () => {
    expect(getSetting(db, "instanceName")).toBeNull();
  });

  it("stores and updates values", () => {
    setSetting(db, "instanceName", "The Band", 1);
    expect(getSetting(db, "instanceName")).toBe("The Band");
    setSetting(db, "defaultLocale", "cs", 2);
    setSetting(db, "instanceName", "Renamed", 3);
    expect(getSetting(db, "instanceName")).toBe("Renamed");
    expect(getSetting(db, "defaultLocale")).toBe("cs");
  });

  it("stores null as a JSON value", () => {
    setSetting(db, "instanceName", "X", 1);
    setSetting(db, "instanceName", null, 2);
    expect(getSetting(db, "instanceName")).toBeNull();
  });

  it("falls back to the default for malformed JSON", () => {
    db.$client
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('instanceName', '{oops', 1)")
      .run();
    expect(getSetting(db, "instanceName")).toBeNull();
  });

  it("validates on write", () => {
    expect(() => {
      setSetting(db, "instanceName", "");
    }).toThrow();
  });

  it("falls back to the default for an invalid stored value", () => {
    db.$client
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('defaultLocale', '\"xx\"', 1)",
      )
      .run();
    expect(getSetting(db, "defaultLocale")).toBeNull();
  });
});
