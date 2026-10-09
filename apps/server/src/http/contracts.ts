import type { Db, UserRow } from "@bandroom/server-core";
import {
  API_PREFIX,
  hasGlobalCapability,
  keyMayCall,
  type ApiScope,
  type ContractDef,
  type ContractResponse,
  type HttpMethod,
  type RouteAuth,
} from "@bandroom/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { z } from "zod";
import { checkBatch, type BatchScopeAccess } from "./batch";
import { AppError } from "./errors";
import {
  checkScope,
  checkSongLock,
  songOfAccess,
  type DocumentScopeAccess,
  type EditSessionScopeAccess,
  type LinkScopeAccess,
  type ScopeAccess,
  type SongScopeAccess,
} from "./scope";

declare module "fastify" {
  interface FastifyInstance {
    /** Database used by the central authorization hook for scoped routes. */
    authDb: Db;
  }
  interface FastifyRequest {
    access: ScopeAccess | BatchScopeAccess | null;
  }
}

type Out<S> = S extends z.ZodType ? z.output<S> : undefined;

/** Public routes may be anonymous; every other route gets a guaranteed user. */
type UserFor<C extends ContractDef> = C["auth"] extends { public: true } ? UserRow | null : UserRow;

/** Scoped routes receive the resolved project/song and the user's role there. */
type AccessFor<C extends ContractDef> = C["auth"] extends { scope: "project" }
  ? Extract<ScopeAccess, { scope: "project" }>
  : C["auth"] extends { scope: "song" | "track" | "trackVersion" | "marker" | "comment" }
    ? SongScopeAccess
    : C["auth"] extends { scope: "document" | "documentVersion" }
      ? DocumentScopeAccess
      : C["auth"] extends { scope: "editSession" }
        ? EditSessionScopeAccess
        : C["auth"] extends { scope: "link" }
          ? LinkScopeAccess
          : C["auth"] extends { batch: string }
            ? BatchScopeAccess
            : null;

export interface HandlerInput<C extends ContractDef> {
  params: Out<C["params"]>;
  query: Out<C["query"]>;
  body: Out<C["body"]>;
  user: UserFor<C>;
  access: AccessFor<C>;
}

export type ContractHandler<C extends ContractDef> = (
  input: HandlerInput<C>,
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<ContractResponse<C>> | ContractResponse<C>;

export interface RouteOptions {
  /** Per-route limit via @fastify/rate-limit (key: client IP unless `keyGenerator` is given). */
  rateLimit?: {
    max: number;
    timeWindow: string | number;
    keyGenerator?: (request: FastifyRequest) => string;
  };
  /** Request body limit in bytes (Fastify's default is 1 MiB). */
  bodyLimit?: number;
}

/**
 * Rate-limit key for signed-in routes: the user (shared NAT and many tabs stay apart), or the
 * client IP for anonymous requests. Session resolution runs before route-level hooks.
 */
export function userOrIpKey(request: FastifyRequest): string {
  if (request.apiKey) return `k:${request.apiKey.id}`;
  return request.user ? `u:${request.user.id}` : `ip:${request.ip}`;
}

/**
 * The single place where route authorization is enforced (SPEC §18.3). Handlers never check
 * permissions themselves.
 */
export function authorize(
  auth: RouteAuth | undefined,
  request: FastifyRequest,
  db: Db,
  apiKey?: ApiScope | false,
): ScopeAccess | null {
  // An API key narrows its user's rights to its scopes first (SPEC §29.2); the normal checks
  // below still apply.
  if (request.apiKey) {
    const route = { method: request.method as HttpMethod, auth, apiKey };
    if (!keyMayCall(request.apiKey.scopes, route)) {
      throw new AppError("API_KEY_SCOPE", "The API key may not call this route");
    }
  }
  if (auth !== undefined && "public" in auth) return null;
  const user = request.user;
  if (user === null) throw new AppError("UNAUTHENTICATED", "Login required");
  if (auth !== undefined && "global" in auth && !hasGlobalCapability(user, auth.global)) {
    throw new AppError("FORBIDDEN", `Missing capability ${auth.global}`);
  }
  if (auth !== undefined && "scope" in auth) {
    const params = request.params as Record<string, string | undefined>;
    const id = params[auth.param ?? "id"];
    if (!id) throw new AppError("NOT_FOUND", "Missing scope id");
    return checkScope(db, user, auth.scope, id, auth.capability, auth.projectCapability);
  }
  return null;
}

/**
 * Registers a shared contract as a Fastify route. Must be called inside the plugin mounted at
 * `{basePath}{API_PREFIX}`. Validation of params/query/body and response serialization use the
 * contract's Zod schemas; authorization runs before validation of the body.
 */
export function registerContract<C extends ContractDef>(
  app: FastifyInstance,
  contract: C,
  handler: ContractHandler<C>,
  options: RouteOptions = {},
): void {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: contract.method,
    url: contract.path,
    ...(options.bodyLimit !== undefined && { bodyLimit: options.bodyLimit }),
    config: { contract, ...(options.rateLimit && { rateLimit: options.rateLimit }) },
    schema: {
      ...(contract.params && { params: contract.params }),
      ...(contract.query && { querystring: contract.query }),
      ...(contract.body && { body: contract.body }),
      response: { 200: contract.response },
    },
    onRequest: (request, _reply, done) => {
      try {
        request.access = authorize(contract.auth, request, app.authDb, contract.apiKey);
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    // After body validation: batch routes check every item of the body (SPEC §26.2), and some
    // routes freeze only some fields while the song is locked.
    preHandler: (request, _reply, done) => {
      try {
        const auth = contract.auth;
        if (auth !== undefined && "batch" in auth && request.user) {
          request.access = checkBatch(
            app.authDb,
            request.user,
            auth.batch,
            request.body as Parameters<typeof checkBatch>[3],
          );
        }
        checkSongLock(app.authDb, auth, songOfAccess(request.access), request.method, request.body);
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    handler: (request, reply) =>
      handler(
        {
          params: request.params as Out<C["params"]>,
          query: request.query as Out<C["query"]>,
          body: request.body as Out<C["body"]>,
          user: request.user as UserFor<C>,
          access: request.access as AccessFor<C>,
        },
        request,
        reply,
      ),
  });
}

export function apiPrefix(basePath: string): string {
  return `${basePath}${API_PREFIX}`;
}

/**
 * Registers a non-contract route (binary downloads, SSE, tus) with the same central
 * authorization as contracts: `request.access` holds the resolved scope.
 */
export function registerAuthorizedRoute(
  app: FastifyInstance,
  route: {
    method: "GET" | "HEAD" | "POST" | "PATCH" | "DELETE" | "OPTIONS" | ("GET" | "HEAD")[];
    url: string;
    auth: RouteAuth;
    /** API-key access as on contracts (SPEC §29.2). */
    apiKey?: ApiScope | false;
  },
  handler: (request: FastifyRequest, reply: FastifyReply) => unknown,
  options: Pick<RouteOptions, "rateLimit"> = {},
): void {
  app.route({
    method: route.method,
    url: route.url,
    ...(options.rateLimit && { config: { rateLimit: options.rateLimit } }),
    onRequest: (request, _reply, done) => {
      try {
        request.access = authorize(route.auth, request, app.authDb, route.apiKey);
        checkSongLock(
          app.authDb,
          route.auth,
          songOfAccess(request.access),
          request.method,
          undefined,
        );
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    handler: (request, reply) => handler(request, reply),
  });
}
