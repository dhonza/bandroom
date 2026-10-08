import type { z } from "zod";
import type { ErrorCode } from "../errors";
import type { Capability } from "../permissions/content";
import type { ApiScope } from "../permissions/apiScopes";
import type { GlobalCapability } from "../permissions/global";

export const API_PREFIX = "/api/v1";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Authorization declaration, enforced centrally by the server (SPEC §18.3); handlers never check
 * permissions themselves. Omitted = any authenticated, enabled user.
 *
 * Scoped routes name a content capability and the path param holding the project or song id
 * (default `id`). Unknown or invisible scopes answer 404, visible ones without the capability 403.
 */
/**
 * Track, track-version, marker and comment scopes resolve to their song. Document and
 * document-version scopes resolve to the song of a song document, or to the project of a
 * project-level document (which needs at least `viewer` on the project, SPEC §3.3).
 */
export type ContentScope =
  | "project"
  | "song"
  | "track"
  | "trackVersion"
  | "marker"
  | "comment"
  | "document"
  | "documentVersion"
  /** A public link: its song for song/versions links, else its project (SPEC §3.5). */
  | "link";

/**
 * Batch actions (SPEC §26.2): every item in the body is resolved and checked centrally; for copy
 * and move also the target project (SPEC §26.6). `inspect` only needs the items to be visible.
 */
export type BatchAction =
  "delete" | "restore" | "purge" | "removeLossless" | "move" | "copy" | "inspect";

export type RouteAuth =
  | { readonly public: true }
  | { readonly batch: BatchAction }
  | { readonly user: true }
  | { readonly global: GlobalCapability }
  | {
      readonly capability: Capability;
      readonly scope: ContentScope;
      readonly param?: string;
      /**
       * Body fields a song lock freezes on this route (SPEC §25.12); its other fields stay
       * editable. Changes needing a frozen capability (comments, markers, tempo) are refused
       * without this.
       */
      readonly lockFields?: readonly string[];
      /**
       * A capability also needed on the scope's project, with the project role (song grants do
       * not count): e.g. a bounce reads the song and creates a song in its project (SPEC §5.5).
       */
      readonly projectCapability?: Capability;
    };

/**
 * One API endpoint, defined once and used by both the server (route registration, validation)
 * and the client (typed calls). `path` is relative to {@link API_PREFIX}, with `:name` params.
 */
export interface ContractDef {
  readonly method: HttpMethod;
  readonly path: `/${string}`;
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  readonly response: z.ZodType;
  readonly errors?: readonly ErrorCode[];
  readonly auth?: RouteAuth;
  /**
   * API-key access (SPEC §29.2): `false` refuses keys (`API_KEY_SCOPE`), a scope overrides the
   * default (GET → read, else write; admin routes admin:read / admin:ops).
   */
  readonly apiKey?: ApiScope | false;
}

export function defineContract<const C extends ContractDef>(contract: C): C {
  return contract;
}

type Part<C extends ContractDef, K extends "params" | "query" | "body"> = C[K] extends z.ZodType
  ? { [P in K]: z.input<C[K]> }
  : { [P in K]?: never };

export type ContractInput<C extends ContractDef> = Part<C, "params"> &
  Part<C, "query"> &
  Part<C, "body">;

export type ContractResponse<C extends ContractDef> = z.output<C["response"]>;

/** Substitutes `:name` segments with URL-encoded values. Throws on a missing param. */
export function buildPath(path: string, params?: Record<string, string | number>): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined) {
      throw new Error(`Missing path param "${name}" for ${path}`);
    }
    return encodeURIComponent(String(value));
  });
}
