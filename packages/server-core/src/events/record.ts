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
  const row: Record<string, string | number | null> = {
    id: uuidv7(ts),
    ts,
    actor_type: e.actorType ?? (e.actorUserId ? "user" : "system"),
    actor_user_id: e.actorUserId ?? null,
    session_id: e.sessionId ?? null,
    link_id: e.linkId ?? null,
    link_session_id: e.linkSessionId ?? null,
    action: e.action,
    project_id: e.projectId ?? null,
    song_id: e.songId ?? null,
    target_type: e.targetType ?? null,
    target_id: e.targetId ?? null,
    ip: e.ip ?? null,
    user_agent: e.userAgent?.slice(0, 400) ?? null,
    details: e.details === undefined ? null : JSON.stringify(e.details),
  };
  // Named only when set: the one-time data steps before the migrations (SPEC §27.2, §28.4) record
  // events on schemas that predate this column (Drizzle would always name every column).
  if (e.apiKeyId) row.api_key_id = e.apiKeyId;
  const cols = Object.keys(row);
  db.$client
    .prepare(`INSERT INTO events (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .run(...Object.values(row));
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
