/**
 * How the service worker handles a request (SPEC §13):
 * - `navigate`: network first, the cached app shell when offline;
 * - `static`: the precached build (cache first);
 * - `blob`: the offline blob cache (cache first, Range-aware), else the network;
 * - `api`: network first; the last response is kept and served when the network fails;
 * - `bypass`: not touched (mutations, SSE, downloads, uploads, public-link routes, other origins).
 */
export type RouteKind = "navigate" | "static" | "blob" | "api" | "bypass";

const BLOB = /^api\/v1\/blobs\/[0-9a-f]{64}$/;

export function classify(
  request: { method: string; mode: string; url: string },
  scope: string,
): RouteKind {
  if (request.method !== "GET") return "bypass";
  const url = new URL(request.url);
  const root = new URL(scope);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return "bypass";
  const rel = url.pathname.slice(root.pathname.length);
  if (rel.startsWith("api/")) {
    // Public-link routes never read or fill the band's offline data (SPEC §3.5).
    if (rel.startsWith("api/v1/l/")) return "bypass";
    if (rel === "api/v1/stream" || rel.startsWith("api/v1/uploads")) return "bypass";
    if (/\/download$/.test(rel)) return "bypass";
    if (BLOB.test(rel)) return "blob";
    return "api";
  }
  if (rel === "healthz" || rel === "sw.js") return "bypass";
  if (request.mode === "navigate") return "navigate";
  return "static";
}

/** Session endpoint: the worker learns the current user from it. */
export function isSessionUrl(url: string, scope: string): boolean {
  return new URL(url).pathname === `${new URL(scope).pathname}api/v1/auth/session`;
}
