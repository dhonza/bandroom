import type { Db, EventInput } from "@bandroom/server-core";
import { recordEvent } from "@bandroom/server-core";
import type { FastifyRequest } from "fastify";

/** Records an activity event with actor, session, IP and user agent taken from the request. */
export function audit(db: Db, request: FastifyRequest, e: EventInput): void {
  recordEvent(db, {
    actorUserId: request.user?.id ?? null,
    sessionId: request.session?.id ?? null,
    ip: request.ip,
    userAgent: request.headers["user-agent"] ?? null,
    ...e,
  });
}
