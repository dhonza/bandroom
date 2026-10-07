import fs from "node:fs/promises";
import path from "node:path";
import { FileStore } from "@tus/file-store";
import type { FastifyInstance } from "fastify";
import { UPLOAD_EXPIRY_MS } from "./tusSupport";

/** How often the API deletes the files of abandoned uploads. */
const UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Directory of in-progress tus uploads. */
export function uploadsDirectory(tmpDir: string): string {
  return path.join(tmpDir, "uploads");
}

/**
 * Deletes the files of unfinished tus uploads created more than 24 h ago (data + `.json`
 * metadata). Finished uploads were already moved into blob storage. Returns the number removed.
 */
export async function cleanUpExpiredUploads(directory: string): Promise<number> {
  try {
    await fs.access(directory);
  } catch {
    return 0; // nothing uploaded yet
  }
  const store = new FileStore({ directory, expirationPeriodInMilliseconds: UPLOAD_EXPIRY_MS });
  return store.deleteExpired();
}

/** Abandoned uploads: removed at startup and hourly. Errors are logged, never thrown. */
export function scheduleUploadCleanup(api: FastifyInstance, directory: string): void {
  let sweeping: Promise<void> | null = null;
  const sweep = () => {
    sweeping ??= cleanUpExpiredUploads(directory)
      .then(
        (removed) => {
          if (removed > 0) api.log.info({ removed }, "expired uploads removed");
        },
        (err: unknown) => {
          api.log.error({ err }, "upload cleanup failed");
        },
      )
      .finally(() => {
        sweeping = null;
      });
  };
  let timer: NodeJS.Timeout | undefined;
  api.addHook("onReady", () => {
    sweep();
    timer = setInterval(sweep, UPLOAD_CLEANUP_INTERVAL_MS);
    timer.unref();
    return Promise.resolve();
  });
  api.addHook("onClose", async () => {
    clearInterval(timer);
    await sweeping;
  });
}
