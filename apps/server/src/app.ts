import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import {
  DEFAULT_TOOLS,
  LocalStorage,
  type Config,
  type Db,
  type ToolPaths,
} from "@bandroom/server-core";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { Logger } from "pino";
import type { AppContext, ImageFetchOptions, SamplyOptions } from "./context";
import { SlotLimiter } from "./http/slotLimiter";
import { apiPrefix } from "./http/contracts";
import { AppError, installErrorHandler } from "./http/errors";
import { LINK_LOCKOUT_THROTTLE, LoginThrottle } from "./http/loginThrottle";
import { installSecurity, registerRobotsTxt } from "./http/security";
import { cookieSettings, installSessionResolution } from "./http/session";
import { registerSpa, type Spa } from "./http/spa";
import { registerAdminRoutes } from "./routes/admin";
import { registerApiKeyRoutes } from "./routes/apiKeys";
import { registerAuthRoutes } from "./routes/auth";
import { registerBatchRoutes } from "./routes/batch";
import { registerBatchTransferRoutes } from "./routes/batchTransfer";
import { registerDirectoryRoutes } from "./routes/directory";
import { EventHub } from "./realtime/hub";
import { registerHealth } from "./routes/health";
import { registerImportRoutes } from "./routes/imports";
import { startJobRunner } from "./importers/runner";
import { samplyImportHandler } from "./importers/samply/job";
import { registerMediaRoutes } from "./routes/media";
import { registerInternalRoutes, registerStreamRoutes } from "./routes/stream";
import { registerMixerRoutes } from "./routes/mixer";
import { registerOfflineRoutes } from "./routes/offline";
import { registerOpsRoutes } from "./routes/ops";
import { registerUpdateRoutes, type UpdateOptions } from "./routes/updates";
import { registerMarkerRoutes } from "./routes/markers";
import { registerEditSessionRoutes } from "./routes/editSessions";
import { registerCommentRoutes } from "./routes/comments";
import { registerNotificationRoutes } from "./routes/notifications";
import { registerTempoRoutes } from "./routes/tempo";
import { registerTrackRoutes, registerVersionRoutes } from "./routes/tracks";
import { registerUploadRoutes } from "./routes/uploads";
import { registerMeRoutes } from "./routes/me";
import { instanceInfo, registerMetaRoutes } from "./routes/meta";
import { registerBrandingRoutes } from "./routes/branding";
import { registerProcessingRoutes } from "./routes/processing";
import { registerProjectImageRoutes } from "./routes/projectImage";
import { registerProjectRoutes } from "./routes/projects";
import { registerSongRoutes } from "./routes/songs";
import { registerDocumentRoutes } from "./routes/documents";
import { registerLinkRoutes } from "./routes/links";
import { registerLinkVisitorRoutes } from "./routes/linkVisitor";
import { APP_VERSION } from "./version";

export interface AppDeps {
  config: Config;
  db: Db;
  logger?: Logger;
  /** Injectable for tests. */
  throttle?: LoginThrottle;
  linkThrottle?: LoginThrottle;
  hub?: EventHub;
  /** ffmpeg slots for WAV downloads (injectable so tests can hold the slot). */
  ffmpegSlots?: SlotLimiter;
  tools?: ToolPaths;
  samply?: SamplyOptions;
  /** Code-only test hook (never from the environment): lets image fetches reach a local server. */
  imageFetch?: ImageFetchOptions;
  /** Run the in-process job runner (Samply importer). Off in `inject()` tests. */
  runJobs?: boolean;
  /** Registry access of the update check (tests inject a fake). */
  updates?: UpdateOptions;
}

/** Builds the Fastify app without listening, so tests can use `app.inject()`. */
export async function buildApp({
  config,
  db,
  logger,
  throttle,
  linkThrottle,
  hub,
  ffmpegSlots,
  tools,
  samply,
  imageFetch = {},
  runJobs = false,
  updates = {},
}: AppDeps): Promise<FastifyInstance> {
  const options: FastifyServerOptions = { trustProxy: config.trustProxy };
  const app = Fastify(logger ? { ...options, loggerInstance: logger } : options);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  installErrorHandler(app);

  const prefix = apiPrefix(config.basePath);
  const ctx: AppContext = {
    config,
    db,
    cookies: cookieSettings(config),
    throttle: throttle ?? new LoginThrottle(),
    linkThrottle: linkThrottle ?? new LoginThrottle(),
    linkLockout: new LoginThrottle(LINK_LOCKOUT_THROTTLE),
    version: APP_VERSION,
    storage: new LocalStorage(config.blobsDir),
    tools: tools ?? DEFAULT_TOOLS,
    hub: hub ?? new EventHub(),
    ffmpegSlots: ffmpegSlots ?? new SlotLimiter(1),
    samply: { baseUrl: config.samplyApiUrl, ...samply },
    imageFetch,
  };

  installSecurity(app, prefix);
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, {
    global: false,
    // In-memory store is bounded by `cache` (SPEC §19.6).
    cache: 10_000,
    errorResponseBuilder: (_request, context) =>
      new AppError("RATE_LIMITED", "Too many requests", {
        retryAfterSec: Math.ceil(context.ttl / 1000),
      }),
  });
  installSessionResolution(app, db, prefix, ctx.cookies);
  // Hijacked SSE streams would otherwise keep `close()` waiting until clients disconnect.
  app.addHook("preClose", (done) => {
    ctx.hub.closeAll();
    done();
  });
  app.decorate("authDb", db);
  app.decorateRequest("access", null);
  app.decorateRequest("linkAccess", null);

  registerRobotsTxt(app);
  registerHealth(app, config.basePath, { db, dataDir: config.dataDir, version: APP_VERSION });
  registerInternalRoutes(app, ctx);

  await app.register(
    (api, _opts, done) => {
      registerMetaRoutes(api, {
        db,
        appName: config.appName,
        defaultLocale: config.defaultLocale,
        version: APP_VERSION,
      });
      registerBrandingRoutes(api, ctx);
      registerAuthRoutes(api, ctx);
      registerMeRoutes(api, ctx);
      registerAdminRoutes(api, ctx);
      registerApiKeyRoutes(api, ctx);
      registerOpsRoutes(api, ctx);
      registerUpdateRoutes(api, ctx, updates);
      registerDirectoryRoutes(api, ctx);
      registerProjectRoutes(api, ctx);
      registerProjectImageRoutes(api, ctx);
      registerSongRoutes(api, ctx);
      registerEditSessionRoutes(api, ctx);
      registerTrackRoutes(api, ctx);
      registerBatchRoutes(api, ctx);
      registerBatchTransferRoutes(api, ctx);
      registerMixerRoutes(api, ctx);
      registerMarkerRoutes(api, ctx);
      registerCommentRoutes(api, ctx);
      registerNotificationRoutes(api, ctx);
      registerTempoRoutes(api, ctx);
      registerVersionRoutes(api, ctx);
      registerMediaRoutes(api, ctx);
      registerDocumentRoutes(api, ctx);
      registerOfflineRoutes(api, ctx);
      registerProcessingRoutes(api, ctx);
      registerStreamRoutes(api, ctx);
      registerUploadRoutes(api, ctx, prefix);
      registerImportRoutes(api, ctx);
      registerLinkRoutes(api, ctx);
      registerLinkVisitorRoutes(api, ctx);
      done();
    },
    { prefix },
  );

  let spa: Spa | undefined;
  if (config.webDistDir !== undefined) {
    spa = await registerSpa(app, {
      distDir: config.webDistDir,
      basePath: config.basePath,
      clientConfig: () => {
        const info = instanceInfo(db, config);
        return {
          appName: info.instanceName,
          defaultLocale: info.defaultLocale,
          logoHash: info.logoHash,
          basePath: config.basePath,
          version: APP_VERSION,
        };
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url === prefix || request.url.startsWith(`${prefix}/`);
    const wantsHtml = (request.headers.accept ?? "").includes("text/html");
    const inApp = request.url.startsWith(`${config.basePath}/`);
    const isRead = request.method === "GET" || request.method === "HEAD";
    if (spa && !isApi && inApp && isRead && wantsHtml) {
      return spa.sendIndex(reply);
    }
    throw new AppError("NOT_FOUND", `Route ${request.method} ${request.url} not found`);
  });

  if (runJobs) {
    const runner = startJobRunner({
      db,
      storage: ctx.storage,
      hub: ctx.hub,
      tmpDir: config.tmpDir,
      handlers: [
        samplyImportHandler({
          appSecret: config.appSecret,
          maxFileBytes: config.maxUploadBytes,
          baseUrl: ctx.samply.baseUrl,
          fetch: ctx.samply.fetch,
        }),
      ],
      log: (msg, extra) => {
        app.log.info(extra ?? {}, msg);
      },
    });
    app.addHook("onClose", async () => {
      await runner.stop();
    });
  }

  return app;
}
