import fs from "node:fs";
import path from "node:path";
import {
  audioBounceHandler,
  audioReencodeHandler,
  audioIngestHandler,
  claimJob,
  blobGcHandler,
  executeJob,
  handlerRegistry,
  LocalStorage,
  hashPassword,
  insertUser,
  loadConfig,
  makeTempDir,
  openDb,
  runMigrations,
  type Config,
  type Db,
} from "@bandroom/server-core";
import { documentIngestHandler, imageIngestHandler } from "@bandroom/server-core/image";
import { API_PREFIX, buildPath, login as loginContract, type ContractDef } from "@bandroom/shared";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../app";
import type { ImageFetchOptions, SamplyOptions } from "../context";
import { LoginThrottle } from "../http/loginThrottle";
import { SlotLimiter } from "../http/slotLimiter";
import { SESSION_COOKIE } from "../http/session";
import { MIGRATIONS_DIR } from "../paths";
import { EventHub } from "../realtime/hub";

export const FAKE_INDEX_HTML =
  '<!doctype html><html><head><meta charset="UTF-8"><script type="module" src="./assets/index-abc.js"></script></head><body><div id="root"></div></body></html>';

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: Config;
  dataDir: string;
  basePath: string;
  throttle: LoginThrottle;
  /** The app's SSE hub (subscribe a fake client to observe published events). */
  hub: EventHub;
  /** The app's ffmpeg slots (take one to simulate a running WAV download). */
  ffmpegSlots: SlotLimiter;
  close: () => Promise<void>;
}

/** Builds an app on a temp data dir with a fake SPA build, for `inject()`-based tests. */
export async function createTestApp(
  env: Record<string, string> = {},
  deps: { samply?: SamplyOptions; imageFetch?: ImageFetchOptions } = {},
): Promise<TestApp> {
  const tmp = makeTempDir();
  const dataDir = path.join(tmp.dir, "data");
  const webDist = path.join(tmp.dir, "web");
  fs.mkdirSync(path.join(webDist, "assets"), { recursive: true });
  fs.writeFileSync(path.join(webDist, "index.html"), FAKE_INDEX_HTML);
  fs.writeFileSync(path.join(webDist, "assets", "index-abc.js"), "console.log(1);");
  fs.writeFileSync(path.join(webDist, "favicon.svg"), "<svg/>");

  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    WEB_DIST_DIR: webDist,
    LOG_LEVEL: "silent",
    ...env,
  });
  const db = openDb(config.dbPath);
  runMigrations(db, MIGRATIONS_DIR);
  const throttle = new LoginThrottle();
  const hub = new EventHub();
  const ffmpegSlots = new SlotLimiter(1);
  const app = await buildApp({
    config,
    db,
    throttle,
    samply: deps.samply,
    imageFetch: deps.imageFetch,
    hub,
    ffmpegSlots,
  });
  await app.ready();
  return {
    app,
    db,
    config,
    dataDir,
    basePath: config.basePath,
    throttle,
    hub,
    ffmpegSlots,
    close: async () => {
      await app.close();
      db.$client.close();
      tmp.cleanup();
    },
  };
}

// --- Auth helpers --------------------------------------------------------------------------------

export const TEST_PASSWORD = "correct-horse-battery";

export async function seedUser(
  t: TestApp,
  username: string,
  globalRole: "admin" | "member" | "guest" = "member",
  password: string = TEST_PASSWORD,
) {
  return insertUser(t.db, {
    username,
    displayName: `${username.charAt(0).toUpperCase()}${username.slice(1)}`,
    globalRole,
    passwordHash: await hashPassword(password),
  });
}

/** Extracts `name=value` of the session cookie from a response, for use in a Cookie header. */
export function sessionCookieFrom(res: LightMyRequestResponse): string | undefined {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  return c && c.value !== "" ? `${c.name}=${c.value}` : undefined;
}

type Input = { params?: Record<string, string>; query?: Record<string, string>; body?: unknown };

/** Calls a contract through `inject`, with the CSRF header and an optional session cookie. */
export function call(
  t: TestApp,
  contract: ContractDef,
  input: Input = {},
  cookie?: string,
): Promise<LightMyRequestResponse> {
  const url = `${t.basePath}${API_PREFIX}${buildPath(contract.path, input.params)}`;
  return t.app.inject({
    method: contract.method,
    url,
    query: input.query,
    headers: { "x-requested-with": "bandroom", ...(cookie && { cookie }) },
    ...(input.body !== undefined && { payload: input.body as Record<string, unknown> }),
  });
}

export async function loginAs(
  t: TestApp,
  login: string,
  password: string = TEST_PASSWORD,
): Promise<string> {
  const res = await call(t, loginContract, { body: { login, password } });
  const cookie = sessionCookieFrom(res);
  if (res.statusCode !== 200 || !cookie)
    throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return cookie;
}

// --- Upload / job helpers ------------------------------------------------------------------------

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** Performs a complete tus upload (create + single PATCH) through `inject`. */
export async function tusUpload(
  t: TestApp,
  cookie: string,
  data: Buffer,
  filename: string,
  target: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string; createStatus: number }> {
  const base = `${t.basePath}${API_PREFIX}/uploads`;
  const create = await t.app.inject({
    method: "POST",
    url: base,
    headers: {
      cookie,
      "x-requested-with": "bandroom",
      "tus-resumable": "1.0.0",
      "upload-length": String(data.length),
      "upload-metadata": `filename ${b64(filename)},target ${b64(JSON.stringify(target))}`,
      ...extraHeaders,
    },
  });
  if (create.statusCode !== 201)
    return { status: create.statusCode, body: create.body, createStatus: create.statusCode };
  const location = create.headers.location;
  if (typeof location !== "string") throw new Error("no Location header");
  const patch = await t.app.inject({
    method: "PATCH",
    url: location,
    headers: {
      cookie,
      "x-requested-with": "bandroom",
      "tus-resumable": "1.0.0",
      "upload-offset": "0",
      "content-type": "application/offset+octet-stream",
      ...extraHeaders,
    },
    payload: data,
  });
  return { status: patch.statusCode, body: patch.body, createStatus: create.statusCode };
}

/** Runs all queued jobs in-process (what the worker does), against the app's data dir. */
export async function runQueuedJobs(t: TestApp): Promise<string[]> {
  const storage = new LocalStorage(path.join(t.dataDir, "blobs"));
  const handlers = handlerRegistry([
    audioIngestHandler,
    audioBounceHandler,
    audioReencodeHandler,
    imageIngestHandler,
    documentIngestHandler,
    blobGcHandler,
  ]);
  const statuses: string[] = [];
  for (;;) {
    const job = claimJob(
      t.db,
      "test-worker",
      [
        "audio.ingest",
        "audio.bounce",
        "audio.reencode",
        "image.ingest",
        "document.ingest",
        "blob.gc",
      ],
      Date.now(),
    );
    if (!job) return statuses;
    statuses.push(
      await executeJob(
        { db: t.db, storage, workerId: "test-worker", tmpRoot: t.dataDir },
        handlers,
        job,
      ),
    );
  }
}
