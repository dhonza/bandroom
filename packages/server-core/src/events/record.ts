import type { ActorType, EventAction } from "@bandroom/shared";
import { uuidv7 } from "@bandroom/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { events } from "../db/schema";

export interface EventInput {
  action: EventAction;
  actorType?: ActorType;
  actorUserId?: string | null;
  sessionId?: string | null;
  /** The API key of a bearer request (SPEC §29.1). */
  apiKeyId?: string | null;
  linkId?: string | null;
  linkSessionId?: string | null;
  projectId?: string | null;
  songId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown>;
  ts?: number;
}

/** Appends one activity event (SPEC §14.1). This is the only write path for `events`. */
export function recordEvent(db: Db, e: EventInput): void {
  const ts = e.ts ?? Date.now();
  db.insert(events)
    .values({
      id: uuidv7(ts),
      ts,
      actorType: e.actorType ?? (e.actorUserId ? "user" : "system"),
      actorUserId: e.actorUserId ?? null,
      sessionId: e.sessionId ?? null,
      apiKeyId: e.apiKeyId ?? null,
      linkId: e.linkId ?? null,
      linkSessionId: e.linkSessionId ?? null,
      action: e.action,
      projectId: e.projectId ?? null,
      songId: e.songId ?? null,
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      ip: e.ip ?? null,
      userAgent: e.userAgent?.slice(0, 400) ?? null,
      details: e.details === undefined ? null : JSON.stringify(e.details),
    })
    .run();
}

export type EventRow = typeof events.$inferSelect;

/** Read helper (tests and, later, the audit log views). */
export function listEvents(
  db: Db,
  filter: { action?: EventAction; targetId?: string } = {},
): EventRow[] {
  const conds = [
    ...(filter.action ? [eq(events.action, filter.action)] : []),
    ...(filter.targetId ? [eq(events.targetId, filter.targetId)] : []),
  ];
  return db
    .select()
    .from(events)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(events.ts), asc(events.id))
    .all();
}
