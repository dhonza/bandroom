/**
 * Normalizes a base path to either `""` (root) or `"/a/b"` (leading slash, no trailing slash).
 */
export function normalizeBasePath(path: string): string {
  const segments = path.split("/").filter((s) => s.length > 0);
  return segments.length === 0 ? "" : `/${segments.join("/")}`;
}

/** Derives the base path from an absolute application URL, e.g. `https://x.cz/bandroom/`. */
export function basePathFromUrl(appUrl: string): string {
  return normalizeBasePath(new URL(appUrl).pathname);
}

/** Joins a normalized base path with an absolute path (`"/api/v1/meta"`). */
export function joinBasePath(basePath: string, path: string): string {
  const base = normalizeBasePath(basePath);
  const rest = path.startsWith("/") ? path : `/${path}`;
  return `${base}${rest}`;
}
