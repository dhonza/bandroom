import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { workers } from "../db/schema";

/** Registers or refreshes a worker's heartbeat (SPEC §4.3 `workers`). */
export function heartbeatWorker(
  db: Db,
  w: {
    id: string;
    name: string;
    kind: "local" | "remote";
    capabilities: readonly string[];
    version: string;
  },
  now: number = Date.now(),
): void {
  db.insert(workers)
    .values({
      id: w.id,
      name: w.name,
      kind: w.kind,
      capabilities: JSON.stringify(w.capabilities),
      lastSeenAt: now,
      version: w.version,
    })
    .onConflictDoUpdate({
      target: workers.id,
      set: {
        lastSeenAt: now,
        capabilities: JSON.stringify(w.capabilities),
        version: w.version,
        name: w.name,
      },
    })
    .run();
}

/** Most recent heartbeat of any local worker (for /healthz). */
export function latestLocalWorkerHeartbeat(db: Db): number | null {
  return (
    db
      .select({ t: workers.lastSeenAt })
      .from(workers)
      .where(eq(workers.kind, "local"))
      .orderBy(desc(workers.lastSeenAt))
      .get()?.t ?? null
  );
}
