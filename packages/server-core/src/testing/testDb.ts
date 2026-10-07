import path from "node:path";
import { openDb, type Db } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { makeTempDir } from "./tempDir";

/** Migrations are owned by apps/server (SPEC §4). */
export const TEST_MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  "../../../../apps/server/drizzle",
);

/** A migrated SQLite database in a temp directory, for tests. */
export function createTestDb(): { db: Db; close: () => void } {
  const tmp = makeTempDir();
  const db = openDb(path.join(tmp.dir, "test.sqlite"));
  runMigrations(db, TEST_MIGRATIONS_DIR);
  return {
    db,
    close: () => {
      db.$client.close();
      tmp.cleanup();
    },
  };
}
