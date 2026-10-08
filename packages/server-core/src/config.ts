import path from "node:path";
import { basePathFromUrl, LocaleSchema } from "@bandroom/shared";
import { z } from "zod";

const DEV_APP_SECRET = "dev-only-insecure-secret-change-me-0123456789";
const DEV_INTERNAL_SECRET = "dev-only-internal-events-secret-0123456789";
const GIB = 1024 ** 3;

const booleanish = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_URL: z.url().optional(),
  APP_NAME: z.string().min(1).default("BandRoom"),
  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters").optional(),
  DATA_DIR: z.string().min(1),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TRUST_PROXY: booleanish.default(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DEFAULT_LOCALE: LocaleSchema.default("en"),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * GIB),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  INTERNAL_EVENTS_SECRET: z.string().min(32).optional(),
  /** Where the worker reaches the API for job events (SPEC §18.4). */
  INTERNAL_API_URL: z.url().optional(),
  /** Directory with the built SPA (`apps/web/dist`). When unset, the server serves only the API. */
  WEB_DIST_DIR: z.string().optional(),
  /** Samply API base URL override (tests/e2e use a local mock; SPEC §17). */
  SAMPLY_API_URL: z.url().optional(),
  /** Seconds before the files of "Delete permanently" / "Empty Trash" are deleted (SPEC §26.3). */
  PURGE_GC_GRACE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(600),
  /** GHCR repository whose release tags the update check lists (SPEC §29.8). */
  UPDATE_IMAGE_REPO: z
    .string()
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/)
    .default("dhonza/bandroom"),
});

export type Env = z.input<typeof EnvSchema>;

export interface Config {
  nodeEnv: "development" | "production" | "test";
  isProduction: boolean;
  appUrl: string;
  appName: string;
  appSecret: string;
  /** `""` or `"/sub/path"`; derived from the pathname of `APP_URL`. */
  basePath: string;
  dataDir: string;
  dbPath: string;
  host: string;
  port: number;
  trustProxy: boolean;
  logLevel: z.infer<typeof EnvSchema>["LOG_LEVEL"];
  defaultLocale: z.infer<typeof LocaleSchema>;
  maxUploadBytes: number;
  workerConcurrency: number;
  internalEventsSecret: string;
  internalApiUrl: string;
  /** Blob storage root (local backend). */
  blobsDir: string;
  /** Scratch space on the data volume (uploads in progress, job temp dirs). */
  tmpDir: string;
  webDistDir: string | undefined;
  samplyApiUrl: string | undefined;
  /** Grace before an explicit purge's files are deleted by `blob.gc` (default 10 min). */
  purgeGcGraceMs: number;
  /** `owner/name` on ghcr.io for the update check. */
  updateImageRepo: string;
  /** Human-readable warnings produced while loading (e.g. dev defaults in use). */
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/** Parses and validates configuration from environment variables (SPEC §19.5). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === "production";
  const warnings: string[] = [];
  const issues: string[] = [];

  let appUrl = e.APP_URL;
  if (appUrl === undefined) {
    if (isProduction) issues.push("APP_URL: required in production");
    appUrl = `http://localhost:${e.PORT}`;
  }

  let appSecret = e.APP_SECRET;
  if (appSecret === undefined) {
    if (isProduction) issues.push("APP_SECRET: required in production");
    else warnings.push("APP_SECRET not set; using an insecure development secret");
    appSecret = DEV_APP_SECRET;
  }

  let internalEventsSecret = e.INTERNAL_EVENTS_SECRET;
  if (internalEventsSecret === undefined) {
    if (isProduction) issues.push("INTERNAL_EVENTS_SECRET: required in production");
    internalEventsSecret = DEV_INTERNAL_SECRET;
  }

  if (issues.length > 0) throw new ConfigError(issues);

  const dataDir = path.resolve(e.DATA_DIR);
  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    appUrl,
    appName: e.APP_NAME,
    appSecret,
    basePath: basePathFromUrl(appUrl),
    dataDir,
    dbPath: path.join(dataDir, "bandroom.sqlite"),
    host: e.HOST,
    port: e.PORT,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    defaultLocale: e.DEFAULT_LOCALE,
    maxUploadBytes: e.MAX_UPLOAD_BYTES,
    workerConcurrency: e.WORKER_CONCURRENCY,
    internalEventsSecret,
    internalApiUrl: e.INTERNAL_API_URL ?? `http://127.0.0.1:${e.PORT}`,
    blobsDir: path.join(dataDir, "blobs"),
    tmpDir: path.join(dataDir, "tmp"),
    webDistDir: e.WEB_DIST_DIR === undefined ? undefined : path.resolve(e.WEB_DIST_DIR),
    samplyApiUrl: e.SAMPLY_API_URL,
    purgeGcGraceMs: e.PURGE_GC_GRACE_SECONDS * 1000,
    updateImageRepo: e.UPDATE_IMAGE_REPO,
    warnings,
  };
}
