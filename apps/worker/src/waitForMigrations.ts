import { setTimeout as sleep } from "node:timers/promises";
import { pendingMigrationCount, type Sqlite } from "@bandroom/server-core";

export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onWait?: (pending: number) => void;
}

/**
 * Resolves once the server has applied all migrations. The worker never migrates itself, to avoid
 * two processes racing on the same SQLite file.
 */
export async function waitForMigrations(
  sqlite: Sqlite,
  migrationsDir: string,
  { intervalMs = 1000, timeoutMs = 120_000, signal, onWait }: WaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = pendingMigrationCount(sqlite, migrationsDir);
    if (pending === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${pending} pending migration(s)`);
    }
    onWait?.(pending);
    await sleep(intervalMs, undefined, { signal });
  }
}
