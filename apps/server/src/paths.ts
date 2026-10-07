import path from "node:path";

/**
 * Drizzle migrations live in `apps/server/drizzle` (SPEC §4). Both `src/*.ts` (dev) and
 * `dist/*.js` (bundled) sit one level below the package root.
 */
export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "drizzle");
