import {
  getCommentRow,
  findLinkByToken,
  linkPolicyOf,
  linkProject,
  linkRowStatus,
  linkSong,
  linkTrack,
  linkVersion,
  liveLinkSession,
  recordEvent,
  verifyLinkSessionCookie,
  type EventInput,
  type LinkRow,
  type LinkSessionRow,
  type ProjectRow,
  type SongRow,
} from "@bandroom/server-core";
import {
  effectiveDownloadPolicy,
  linkCanDownload,
  linkHasCapability,
  linkRole,
  linkShowsComment,
  LINK_TOKEN_RE,
  type ContractDef,
  type ContractResponse,
  type LinkPolicy,
  type RouteAuth,
} from "@bandroom/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { z } from "zod";
import type { AppContext } from "../context";
import { apiPrefix, type RouteOptions } from "./contracts";
import { AppError } from "./errors";
import { checkSongLock } from "./scope";

/**
 * Public-link visitors (SPEC §3.5, §18.3). Every visitor route lives under `/l/:linkToken` and is
 * authorized here, never in handlers: the link must exist and be active (unknown, inactive,
 * expired and revoked links all answer NOT_FOUND), the signed session cookie must belong to this
 * link, and scoped routes must stay inside what the link shows. Visitors are at most commenters;
 * the user session of a band member who opens a link is ignored on these routes.
 */
export const LINK_COOKIE = "bandroom_link";
export const LINK_ROUTE_PREFIX = "/l/:linkToken";

export interface LinkPrincipal {
  link: LinkRow;
  policy: LinkPolicy;
  project: ProjectRow;
  token: string;
  /** Null only on routes that do not need a session (open, unlock). */
  session: LinkSessionRow | null;
}

export interface LinkAccess extends LinkPrincipal {
  /** The covered song of song-level scopes. */
  song: SongRow | null;
  /** Id of the scoped entity (song, track, version, comment). */
  targetId: string | null;
  role: "viewer" | "commenter";
}

declare module "fastify" {
  interface FastifyRequest {
    linkAccess: LinkAccess | null;
  }
}

/** Cookie scoped to this link's API routes, so several links in one browser do not collide. */
export function linkCookiePath(ctx: Pick<AppContext, "config">, token: string): string {
  return `${apiPrefix(ctx.config.basePath)}/l/${token}`;
}

/** The link behind the URL token, only while it can be opened. */
export function resolveLinkPrincipal(ctx: AppContext, request: FastifyRequest): LinkPrincipal {
  const token = (request.params as Record<string, string | undefined>).linkToken ?? "";
  if (!LINK_TOKEN_RE.test(token)) throw new AppError("NOT_FOUND", "Link not found");
  const link = findLinkByToken(ctx.db, token);
  const project = link && linkProject(ctx.db, link);
  if (!link || !project || linkRowStatus(link) !== "active")
    throw new AppError("NOT_FOUND", "Link not found");
  if (link.songId !== null && !linkSong(ctx.db, link, link.songId))
    throw new AppError("NOT_FOUND", "Link not found");
  const value = request.cookies[LINK_COOKIE];
  const sessionId = value ? verifyLinkSessionCookie(ctx.config.appSecret, link.id, value) : null;
  const session = (sessionId && liveLinkSession(ctx.db, link.id, sessionId)) || null;
  return { link, policy: linkPolicyOf(link), project, token, session };
}

/** The central check for visitor routes. */
export function authorizeLink(
  ctx: AppContext,
  auth: RouteAuth | undefined,
  request: FastifyRequest,
): LinkAccess {
  const p = resolveLinkPrincipal(ctx, request);
  const role = linkRole(p.policy);
  const base: LinkAccess = { ...p, song: null, targetId: null, role };
  if (auth !== undefined && "public" in auth) return base;
  if (p.session === null) throw new AppError("UNAUTHENTICATED", "Open the link first");
  if (auth === undefined || !("scope" in auth)) return base;

  const id = (request.params as Record<string, string | undefined>)[auth.param ?? "id"] ?? "";
  const { db } = ctx;
  let song: SongRow | undefined;
  switch (auth.scope) {
    case "link":
      break;
    case "project":
      if (id !== p.link.projectId) throw new AppError("NOT_FOUND", "Not found");
      break;
    case "song":
      song = linkSong(db, p.link, id);
      if (!song) throw new AppError("NOT_FOUND", "Not found");
      break;
    case "track":
      song = linkTrack(db, p.link, id)?.song;
      if (!song) throw new AppError("NOT_FOUND", "Not found");
      break;
    case "trackVersion":
      song = linkVersion(db, p.link, id)?.song;
      if (!song) throw new AppError("NOT_FOUND", "Not found");
      break;
    case "comment": {
      const c = getCommentRow(db, id);
      song = c && c.deletedAt === null ? linkSong(db, p.link, c.songId) : undefined;
      if (!c || !song || !linkShowsComment(p.policy, p.link.id, c))
        throw new AppError("NOT_FOUND", "Not found");
      break;
    }
    default:
      throw new AppError("NOT_FOUND", "Not found");
  }
  if (!linkHasCapability(p.policy, auth.capability))
    throw new AppError("FORBIDDEN", `Missing capability ${auth.capability}`);
  if (
    auth.capability === "download" &&
    !linkCanDownload(
      p.policy,
      effectiveDownloadPolicy(song?.downloadPolicy ?? null, p.project.downloadPolicy),
    )
  ) {
    throw new AppError("FORBIDDEN", "Downloads are not allowed");
  }
  return { ...base, song: song ?? null, targetId: id || null };
}

/** Whether the visitor may download files of this song (link flag + download policy). */
export function linkDownloadAllowed(access: LinkAccess, song: SongRow): boolean {
  return linkCanDownload(
    access.policy,
    effectiveDownloadPolicy(song.downloadPolicy, access.project.downloadPolicy),
  );
}

/** Records a visitor event: actor `link`, with link and link-session ids (SPEC §3.5, §14.1). */
export function linkAudit(
  ctx: Pick<AppContext, "db">,
  request: FastifyRequest,
  access: Pick<LinkPrincipal, "link" | "session">,
  e: EventInput,
): void {
  recordEvent(ctx.db, {
    actorType: "link",
    actorUserId: null,
    sessionId: null,
    linkId: access.link.id,
    linkSessionId: access.session?.id ?? null,
    projectId: access.link.projectId,
    ip: request.ip,
    userAgent: request.headers["user-agent"] ?? null,
    ...e,
  });
}

type Out<S> = S extends z.ZodType ? z.output<S> : undefined;

export interface LinkHandlerInput<C extends ContractDef> {
  params: Out<C["params"]>;
  query: Out<C["query"]>;
  body: Out<C["body"]>;
  access: LinkAccess;
}

/**
 * Registers a shared contract for link visitors at `/l/:linkToken{contract.path}`, with the
 * contract's validation and the central link authorization. The same contracts serve the
 * logged-in app, so the link view reuses the song page's queries unchanged.
 */
export function registerLinkContract<C extends ContractDef>(
  app: FastifyInstance,
  ctx: AppContext,
  contract: C,
  handler: (
    input: LinkHandlerInput<C>,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<ContractResponse<C>> | ContractResponse<C>,
  options: RouteOptions = {},
): void {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: contract.method,
    url: `${LINK_ROUTE_PREFIX}${contract.path}`,
    ...(options.bodyLimit !== undefined && { bodyLimit: options.bodyLimit }),
    config: { contract, ...(options.rateLimit && { rateLimit: options.rateLimit }) },
    schema: {
      ...(contract.query && { querystring: contract.query }),
      ...(contract.body && { body: contract.body }),
      response: { 200: contract.response },
    },
    onRequest: (request, reply, done) => {
      try {
        reply.header("Cache-Control", "no-store");
        request.linkAccess = authorizeLink(ctx, contract.auth, request);
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    // Visitors' comments are frozen too while the song is locked (SPEC §25.12).
    preHandler: (request, _reply, done) => {
      try {
        checkSongLock(contract.auth, request.linkAccess?.song, request.method, request.body);
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    handler: (request, reply) => {
      // Validated here (not in the schema) because the route also carries `linkToken`.
      const parsed = contract.params?.safeParse(request.params);
      if (parsed && !parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid params");
      return handler(
        {
          params: parsed?.data as Out<C["params"]>,
          query: request.query as Out<C["query"]>,
          body: request.body as Out<C["body"]>,
          access: request.linkAccess as LinkAccess,
        },
        request,
        reply,
      );
    },
  });
}

/** A non-contract visitor route (blobs, downloads) with the same authorization. */
export function registerLinkRoute(
  app: FastifyInstance,
  ctx: AppContext,
  route: { method: "GET" | ("GET" | "HEAD")[]; url: `/${string}`; auth: RouteAuth },
  handler: (request: FastifyRequest, reply: FastifyReply, access: LinkAccess) => unknown,
  options: Pick<RouteOptions, "rateLimit"> = {},
): void {
  app.route({
    method: route.method,
    url: `${LINK_ROUTE_PREFIX}${route.url}`,
    ...(options.rateLimit && { config: { rateLimit: options.rateLimit } }),
    onRequest: (request, _reply, done) => {
      try {
        request.linkAccess = authorizeLink(ctx, route.auth, request);
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    handler: (request, reply) => handler(request, reply, request.linkAccess as LinkAccess),
  });
}
