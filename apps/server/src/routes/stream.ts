import {
  liveSessionUser,
  resolveProjectAccess,
  resolveSongAccess,
  safeEqual,
  type UserRow,
} from "@bandroom/server-core";
import {
  hasCapability,
  roleAtLeast,
  StreamEventSchema,
  type Capability,
  type StreamEvent,
} from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { registerAuthorizedRoute, userOrIpKey } from "../http/contracts";
import { AppError } from "../http/errors";

const HEARTBEAT_MS = 25_000;
/** A client that lets this much pile up unread is dropped (it reconnects and replays). */
export const MAX_SSE_BUFFER_BYTES = 256 * 1024;
const PERMISSION_CACHE_MS = 30_000;

/**
 * Event types only users with a capability beyond `view` may receive (review L13): link changes
 * are for those who manage links.
 */
const REQUIRED_CAPABILITY: ReadonlyMap<string, Capability> = new Map([
  ["link.changed", "link.manage"],
  // Trash lists (SPEC §26.3) are for users who may delete something there.
  ["trash.changed", "delete.own"],
]);

/** Per-connection permission filter with a short cache (progress events arrive in bursts). */
export function makeFilter(ctx: Pick<AppContext, "db">, user: UserRow) {
  const cache = new Map<string, { ok: boolean; until: number }>();
  const cached = (key: string, compute: () => boolean) => {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.until > now) return hit.ok;
    const ok = compute();
    if (cache.size > 500) cache.clear();
    cache.set(key, { ok, until: now + PERMISSION_CACHE_MS });
    return ok;
  };
  return (event: StreamEvent): boolean => {
    if (event.userId) return event.userId === user.id; // notifications (SPEC §18.5)
    const capability = REQUIRED_CAPABILITY.get(event.type);
    if (event.songId) {
      const songId = event.songId;
      return cached(`s:${songId}:${capability ?? ""}`, () => {
        const a = resolveSongAccess(ctx.db, user, songId);
        return (
          a !== undefined &&
          roleAtLeast(a.role, "viewer") &&
          (capability === undefined || hasCapability(a.role, capability))
        );
      });
    }
    if (event.projectId) {
      const projectId = event.projectId;
      return cached(`p:${projectId}:${capability ?? ""}`, () => {
        const a = resolveProjectAccess(ctx.db, user, projectId);
        return (
          a !== undefined &&
          a.visibility !== "hidden" &&
          (capability === undefined ||
            (a.visibility === "full" && hasCapability(a.role, capability)))
        );
      });
    }
    return user.globalRole === "admin"; // unscoped system events
  };
}

/**
 * `GET {api}/stream` (SPEC §18.5): one SSE connection per tab, 25 s heartbeat, replay via
 * `Last-Event-ID`. `POST /internal/events`: the worker publishes job events (shared secret;
 * Caddy never proxies /internal).
 */
export function registerStreamRoutes(api: FastifyInstance, ctx: AppContext): void {
  registerAuthorizedRoute(
    api,
    // Keys are refused: the stream's liveness check is tied to the session (SPEC §29.2).
    { method: "GET", url: "/stream", auth: { user: true }, apiKey: false },
    (request, reply) => {
      const user = request.user;
      if (!user) throw new AppError("UNAUTHENTICATED", "Login required");
      const lastHeader = request.headers["last-event-id"];
      const lastId =
        typeof lastHeader === "string" && /^\d+$/.test(lastHeader) ? Number(lastHeader) : null;

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 5000\n\n");
      const sessionId = request.session?.id ?? null;
      // Logout, revocation, disabling and role changes end the stream (the client reconnects
      // with its current rights, or is sent to login).
      const stillValid = () => {
        const current = sessionId === null ? undefined : liveSessionUser(ctx.db, sessionId);
        return current !== undefined && current.globalRole === user.globalRole;
      };
      const state = { closed: false, unsubscribe: (): void => undefined };
      const heartbeat = setInterval(() => {
        if (stillValid()) send(": ping\n\n");
        else close(false);
      }, HEARTBEAT_MS);
      const close = (abort: boolean) => {
        if (state.closed) return;
        state.closed = true;
        clearInterval(heartbeat);
        state.unsubscribe();
        if (abort) res.destroy();
        else res.end();
      };
      const send = (frame: string) => {
        if (state.closed) return;
        // Backpressure: a stalled reader must not buffer events in memory without bound.
        if (!res.write(frame) && res.writableLength > MAX_SSE_BUFFER_BYTES) close(true);
      };
      state.unsubscribe = ctx.hub.subscribe(
        {
          canSee: makeFilter(ctx, user),
          send,
          userId: user.id,
          stillValid,
          close: () => {
            close(false);
          },
        },
        lastId,
      );
      // The replay may already have overflowed the buffer (closed before we could unsubscribe).
      if (state.closed) state.unsubscribe();
      request.raw.on("close", () => {
        close(true);
      });
    },
    // A tab opens one stream and reconnects with backoff; this only stops reconnect storms.
    { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: userOrIpKey } },
  );
}

const InternalEventsSchema = z.object({ events: z.array(StreamEventSchema).max(500) });

export function registerInternalRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/internal/events", (request, reply) => {
    const secret = request.headers["x-internal-secret"];
    if (typeof secret !== "string" || !safeEqual(secret, ctx.config.internalEventsSecret)) {
      throw new AppError("NOT_FOUND", "Not found");
    }
    const { events } = InternalEventsSchema.parse(request.body);
    for (const e of events) ctx.hub.publish(e);
    return reply.status(204).send();
  });
}
