import path from "node:path";

/**
 * The server owns and applies migrations (`apps/server/drizzle`); the worker only waits for them.
 * In the Docker image both apps keep the repository layout.
 */
export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "..", "server", "drizzle");
