import { z } from "zod";
import type { HttpMethod, RouteAuth } from "../api/contract";

/**
 * Scopes of an API key (SPEC §29.2). `write` implies `read`, `admin:ops` implies `admin:read`;
 * admin scopes give no content access. A key never widens its user's rights: the scope check runs
 * before, never instead of, the normal authorization.
 */
export const API_SCOPES = ["read", "write", "admin:read", "admin:ops"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const ApiScopeSchema = z.enum(API_SCOPES);

/** Scopes only admins may put on a key. */
export const ADMIN_API_SCOPES: readonly ApiScope[] = ["admin:read", "admin:ops"];

const IMPLIED: Record<ApiScope, readonly ApiScope[]> = {
  read: [],
  write: ["read"],
  "admin:read": [],
  "admin:ops": ["admin:read"],
};

/** A route as the scope check sees it: method, authorization and an optional key override. */
export interface ScopedRoute {
  readonly method: HttpMethod | "HEAD" | "OPTIONS";
  readonly auth?: RouteAuth;
  /** `false` excludes keys; a scope overrides the method-based default. */
  readonly apiKey?: ApiScope | false;
}

/**
 * The scope a key needs for a route, or `null` when keys may not use it at all. Admin routes
 * (`global: admin.access`) need `admin:read` to read and `admin:ops` to change; every other route
 * `read` or `write` by method.
 */
export function requiredScope(route: ScopedRoute): ApiScope | null {
  if (route.apiKey === false) return null;
  if (route.apiKey !== undefined) return route.apiKey;
  const reads = route.method === "GET" || route.method === "HEAD" || route.method === "OPTIONS";
  const admin =
    route.auth !== undefined && "global" in route.auth && route.auth.global === "admin.access";
  if (admin) return reads ? "admin:read" : "admin:ops";
  return reads ? "read" : "write";
}

/** True when the granted scopes cover `needed` (directly or by implication). */
export function hasScope(granted: readonly ApiScope[], needed: ApiScope): boolean {
  return granted.some((s) => s === needed || IMPLIED[s].includes(needed));
}

/** True when a key with these scopes may call the route. */
export function keyMayCall(granted: readonly ApiScope[], route: ScopedRoute): boolean {
  const needed = requiredScope(route);
  return needed !== null && hasScope(granted, needed);
}

/** Whether a user of this global role may create a key with these scopes. */
export function scopesAllowedFor(role: string, scopes: readonly ApiScope[]): boolean {
  return role === "admin" || !scopes.some((s) => ADMIN_API_SCOPES.includes(s));
}
