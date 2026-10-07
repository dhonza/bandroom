import fs from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { z } from "zod";
import type { Db, Sqlite } from "./connection";

const JournalSchema = z.object({
  entries: z.array(z.object({ idx: z.number(), when: z.number(), tag: z.string() })),
});

/** Applies pending Drizzle migrations. Only the API server calls this (on start). */
export function runMigrations(db: Db, migrationsFolder: string): void {
  migrate(db, { migrationsFolder });
}

/**
 * Number of migrations in `migrationsFolder` not yet applied. The worker uses this to wait for
 * the server instead of racing it to migrate.
 */
export function pendingMigrationCount(sqlite: Sqlite, migrationsFolder: string): number {
  const journalFile = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JournalSchema.parse(JSON.parse(fs.readFileSync(journalFile, "utf8")));
  const hasTable = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (hasTable === undefined) return journal.entries.length;
  const row = sqlite.prepare("SELECT MAX(created_at) AS last FROM __drizzle_migrations").get() as
    { last: number | null } | undefined;
  const last = row?.last ?? -1;
  return journal.entries.filter((e) => e.when > last).length;
}
