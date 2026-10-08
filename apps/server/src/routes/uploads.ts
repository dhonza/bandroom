import fs from "node:fs/promises";
import { EVENTS, Server } from "@tus/server";
import { FileStore } from "@tus/file-store";
import {
  diskUsage,
  getUsage,
  createUploadSession,
  deleteUploadSession,
  reservedUploadBytes,
  getUploadSession,
} from "@bandroom/server-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { userOrIpKey } from "../http/contracts";
import { effectiveQuota, MIN_FREE_AFTER_UPLOAD, QUOTA_OVERHEAD } from "../quota";
import { scheduleUploadCleanup, uploadsDirectory } from "./uploads/cleanup";
import { finishUpload } from "./uploads/finishMedia";
import {
  adminNames,
  authorizeTarget,
  clientApiKeys,
  clientIps,
  parseTarget,
  toTusError,
  tusError,
  UPLOAD_EXPIRY_MS,
  userOf,
} from "./uploads/tusSupport";

export { cleanUpExpiredUploads, uploadsDirectory } from "./uploads/cleanup";

/** Upload creations per user (or IP) and minute; a folder drop creates one per file. */
export const UPLOAD_CREATE_LIMIT = {
  max: 120,
  timeWindow: "1 minute",
  keyGenerator: userOrIpKey,
} as const;

/**
 * tus resumable uploads (SPEC §5.1) at `{api}/uploads`. Creation checks permission, quota
 * (declared size × 1.1), max size and free disk; completion hashes the file into blob storage,
 * creates the asset and target entity, and enqueues the ingest job.
 */
export function registerUploadRoutes(
  api: FastifyInstance,
  ctx: AppContext,
  apiPrefix: string,
): void {
  const directory = uploadsDirectory(ctx.config.tmpDir);
  const { db } = ctx;

  scheduleUploadCleanup(api, directory);

  // Created on first use: the FileStore creates its directory asynchronously on construction.
  let tus: Server | undefined;
  const getTus = async (): Promise<Server> => {
    if (tus) return tus;
    await fs.mkdir(directory, { recursive: true });
    tus = createTusServer();
    return tus;
  };

  const createTusServer = () => {
    const server = new Server({
      path: `${apiPrefix}/uploads`,
      datastore: new FileStore({ directory, expirationPeriodInMilliseconds: UPLOAD_EXPIRY_MS }),
      relativeLocation: true,
      respectForwardedHeaders: ctx.config.trustProxy,
      maxSize: ctx.config.maxUploadBytes,
      async onUploadCreate(req, upload) {
        try {
          const user = userOf(ctx, req);
          const size = upload.size;
          if (size === undefined)
            throw tusError("VALIDATION_FAILED", 400, "Upload-Length is required");
          if (size > ctx.config.maxUploadBytes) {
            throw tusError("FILE_TOO_LARGE", 413, "File too large", {
              maxBytes: ctx.config.maxUploadBytes,
            });
          }
          const { target, filename } = parseTarget(upload);
          authorizeTarget(ctx, user, target);

          const quota = effectiveQuota(ctx, user);
          // Uploads still in progress hold their declared size (review M8).
          const used = getUsage(db, user.id) + reservedUploadBytes(db, user.id) * QUOTA_OVERHEAD;
          if (quota !== null && used + size * QUOTA_OVERHEAD > quota) {
            throw tusError("QUOTA_EXCEEDED", 413, "Quota exceeded", {
              remainingBytes: Math.max(0, Math.floor(quota - used)),
              admins: adminNames(ctx),
            });
          }
          const disk = await diskUsage(ctx.config.dataDir);
          if (disk.freeBytes - size < MIN_FREE_AFTER_UPLOAD)
            throw tusError("DISK_FULL", 507, "Server storage is full");

          const now = Date.now();
          createUploadSession(db, {
            id: upload.id,
            userId: user.id,
            targetType: target.type,
            target: JSON.stringify(target),
            filename,
            declaredSize: size,
            createdAt: now,
            expiresAt: now + UPLOAD_EXPIRY_MS,
            completedAt: null,
          });
          return {};
        } catch (err) {
          throw toTusError(err);
        }
      },
      onIncomingRequest(req, uploadId) {
        // Only the user who created an upload may resume, inspect or cancel it.
        if (req.method !== "POST" && req.method !== "OPTIONS") {
          const user = userOf(ctx, req);
          const s = getUploadSession(db, uploadId);
          if (!s || s.userId !== user.id) throw tusError("NOT_FOUND", 404, "Upload not found");
        }
        return Promise.resolve();
      },
      async onUploadFinish(req, upload) {
        try {
          return {
            status_code: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(await finishUpload(ctx, req, upload)),
          };
        } catch (err) {
          throw toTusError(err);
        }
      },
    });
    // A cancelled upload no longer holds quota (onIncomingRequest checked the owner).
    server.on(EVENTS.POST_TERMINATE, (_req, _res, id) => {
      deleteUploadSession(db, id);
    });
    return server;
  };

  // tus reads the raw request body itself; keep Fastify's parser away from it.
  api.addContentTypeParser("application/offset+octet-stream", (_req, _payload, done) => {
    done(null);
  });
  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    const server = await getTus();
    clientIps.set(request.raw, request.ip);
    if (request.apiKey) clientApiKeys.set(request.raw, request.apiKey.id);
    reply.hijack();
    await server.handle(request.raw, reply.raw);
  };
  // Creating an upload reserves quota and disk and writes a session row, so it is limited; the
  // chunk requests (PATCH) of an upload are not.
  api.route({
    method: "POST",
    url: "/uploads",
    handler: handle,
    config: { rateLimit: UPLOAD_CREATE_LIMIT },
  });
  api.route({ method: ["HEAD", "DELETE", "OPTIONS"], url: "/uploads", handler: handle });
  api.route({
    method: ["POST", "PATCH", "HEAD", "DELETE", "OPTIONS"],
    url: "/uploads/*",
    handler: handle,
  });
}
