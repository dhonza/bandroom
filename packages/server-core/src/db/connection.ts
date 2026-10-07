import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type Sqlite = Database.Database;
export type Db = BetterSQLite3Database<typeof schema> & { $client: Sqlite };

/**
 * Opens the SQLite database with the pragmas required by SPEC §4. `busy_timeout` matters
 * because the server and the worker share the same file.
 */
export function openSqlite(file: string): Sqlite {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  return sqlite;
}

/**
 * Transactions are IMMEDIATE unless a caller asks otherwise: they take the write lock at BEGIN,
 * where SQLite waits `busy_timeout` for the other process. A DEFERRED transaction starts as a
 * reader, and its first write upgrades the lock without the busy handler, so it fails at once
 * with "database is locked" whenever the worker (or server) is writing at that moment, or
 * with SQLITE_BUSY_SNAPSHOT when the other process committed since the read.
 */
export function createDb(sqlite: Sqlite): Db {
  const db = drizzle({ client: sqlite, schema });
  const transaction = db.transaction.bind(db);
  db.transaction = (fn, config) => transaction(fn, { behavior: "immediate", ...config });
  return db;
}

export function openDb(file: string): Db {
  return createDb(openSqlite(file));
}
