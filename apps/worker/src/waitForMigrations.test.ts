import path from "node:path";
import { makeTempDir, openDb, runMigrations } from "@bandroom/server-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "./paths";
import { waitForMigrations } from "./waitForMigrations";

let tmp: ReturnType<typeof makeTempDir>;
beforeEach(() => {
  tmp = makeTempDir();
});
afterEach(() => {
  tmp.cleanup();
});

describe("waitForMigrations", () => {
  it("resolves once the server has migrated", async () => {
    const file = path.join(tmp.dir, "db.sqlite");
    const workerDb = openDb(file);
    const serverDb = openDb(file);
    let waits = 0;
    await waitForMigrations(workerDb.$client, MIGRATIONS_DIR, {
      intervalMs: 5,
      onWait: () => {
        waits++;
        if (waits === 2) runMigrations(serverDb, MIGRATIONS_DIR);
      },
    });
    expect(waits).toBe(2);
    workerDb.$client.close();
    serverDb.$client.close();
  });

  it("times out", async () => {
    const db = openDb(path.join(tmp.dir, "other.sqlite"));
    await expect(
      waitForMigrations(db.$client, MIGRATIONS_DIR, { intervalMs: 5, timeoutMs: 20 }),
    ).rejects.toThrow(/Timed out/);
    db.$client.close();
  });
});
