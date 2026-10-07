import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/connection";
import { clientRequests } from "../db/schema";

/** Client request ids are kept for 7 days (SPEC §4.4). */
export const CLIENT_REQUEST_TTL_MS = 7 * 24 * 3600_000;

/** The stored response of an earlier request with this id, if any (SPEC §18.3). */
export function storedClientResponse(
  db: Db,
  userId: string,
  requestId: string,
  route: string,
): unknown {
  const row = db
    .select()
    .from(clientRequests)
    .where(and(eq(clientRequests.userId, userId), eq(clientRequests.requestId, requestId)))
    .get();
  if (!row || row.route !== route) return undefined;
  try {
    return JSON.parse(row.response) as unknown;
  } catch {
    return undefined;
  }
}

export function storeClientResponse(
  db: Db,
  userId: string,
  requestId: string,
  route: string,
  response: unknown,
  now = Date.now(),
): void {
  db.insert(clientRequests)
    .values({ userId, requestId, route, response: JSON.stringify(response), createdAt: now })
    .onConflictDoNothing()
    .run();
}

/** Daily maintenance: drops request ids older than the TTL. */
export function purgeClientRequests(db: Db, now = Date.now()): number {
  return db
    .delete(clientRequests)
    .where(lt(clientRequests.createdAt, now - CLIENT_REQUEST_TTL_MS))
    .run().changes;
}
