import fs from "node:fs";
import path from "node:path";
import {
  cancelAdminUpdate,
  compareTagsDesc,
  getAdminUpdates,
  RELEASE_TAG_RE,
  requestAdminUpdate,
  UpdateResultSchema,
  uuidv7,
  type UpdateRequest,
  type UpdateResult,
} from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract, userOrIpKey } from "../http/contracts";
import { AppError } from "../http/errors";
import { opsDir, readStatusFile } from "./ops";

/** Registry tags are fetched again after this long (SPEC §29.8). */
export const UPDATE_CHECK_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
/** Kept by the app: only the newest release tags matter. */
const MAX_TAGS = 30;

export interface UpdateOptions {
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Default `https://ghcr.io`. */
  registryUrl?: string;
}

const TokenSchema = z.object({ token: z.string().min(1) });
const TagsSchema = z.object({ tags: z.array(z.string()).nullable() });

/** Release tags of an image repository on a Docker registry v2 with anonymous pull tokens. */
export async function fetchReleaseTags(repo: string, opts: UpdateOptions = {}): Promise<string[]> {
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.registryUrl ?? "https://ghcr.io").replace(/\/+$/, "");
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const tokenRes = await doFetch(
    `${base}/token?scope=${encodeURIComponent(`repository:${repo}:pull`)}`,
    { signal },
  );
  if (!tokenRes.ok) throw new Error(`token request failed: ${tokenRes.status}`);
  const { token } = TokenSchema.parse(await tokenRes.json());
  const tagsRes = await doFetch(`${base}/v2/${repo}/tags/list?n=1000`, {
    signal,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!tagsRes.ok) throw new Error(`tags request failed: ${tagsRes.status}`);
  const { tags } = TagsSchema.parse(await tagsRes.json());
  return (tags ?? [])
    .filter((t) => RELEASE_TAG_RE.test(t))
    .sort(compareTagsDesc)
    .slice(0, MAX_TAGS);
}

const RequestFileSchema = z.object({
  id: z.string(),
  action: z.enum(["deploy", "rollback"]),
  tag: z.string().nullable(),
  requestedBy: z.string(),
  ts: z.number(),
});

function readRequest(file: string, state: UpdateRequest["state"]): UpdateRequest | null {
  const raw = readStatusFile(file);
  const parsed = raw ? RequestFileSchema.safeParse(raw) : null;
  if (!parsed?.success) return null;
  const tag =
    parsed.data.tag !== null && RELEASE_TAG_RE.test(parsed.data.tag) ? parsed.data.tag : null;
  return { ...parsed.data, tag, state };
}

/** The newest `result-<id>.json` the watcher wrote (by modification time). */
function readLastResult(dir: string): UpdateResult | null {
  let newest: { file: string; mtime: number } | null = null;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!/^result-[0-9a-f-]{36}\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    } catch {
      // Removed meanwhile.
    }
  }
  if (!newest) return null;
  const parsed = UpdateResultSchema.safeParse(readStatusFile(newest.file));
  return parsed.success ? parsed.data : null;
}

/** Remote updates (SPEC §29.8): the app only writes a request file for the host watcher. */
export function registerUpdateRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  options: UpdateOptions = {},
): void {
  const { config, db } = ctx;
  const dir = opsDir(config.dataDir);
  const requestFile = path.join(dir, "request.json");
  const runningFile = path.join(dir, "running.json");
  const cache: { tags: string[] | null; at: number | null } = { tags: null, at: null };

  const check = async (force: boolean): Promise<string[]> => {
    if (!force && cache.tags && cache.at !== null && Date.now() - cache.at < UPDATE_CHECK_TTL_MS) {
      return cache.tags;
    }
    try {
      cache.tags = await fetchReleaseTags(config.updateImageRepo, options);
      cache.at = Date.now();
      return cache.tags;
    } catch (err) {
      app.log.warn({ err }, "update check failed");
      throw new AppError("UPDATE_CHECK_FAILED", "Could not list release tags");
    }
  };

  const current = (): UpdateRequest | null =>
    readRequest(runningFile, "running") ?? readRequest(requestFile, "pending");
  const isBusy = () => fs.existsSync(requestFile) || fs.existsSync(runningFile);

  registerContract(
    app,
    getAdminUpdates,
    async ({ query }) => {
      if (query.check !== "false") await check(query.check === "force");
      const host = readStatusFile(path.join(dir, "host-status.json"));
      const hostTs = host && typeof host.ts === "number" ? host.ts : null;
      return {
        running: ctx.version,
        available: cache.tags,
        checkedAt: cache.at,
        imageRepo: config.updateImageRepo,
        request: current(),
        lastResult: readLastResult(dir),
        hostStatusAt: hostTs,
      };
    },
    { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: userOrIpKey } },
  );

  registerContract(
    app,
    requestAdminUpdate,
    async ({ body, user }, request) => {
      if (isBusy()) throw new AppError("UPDATE_PENDING", "An update is already pending or running");
      let tag: string | null = null;
      if (body.action === "deploy") {
        const tags = await check(false);
        if (!tags.includes(body.tag)) throw new AppError("UPDATE_TAG_UNKNOWN", "Unknown tag");
        tag = body.tag;
      } else if (body.confirmRunningVersion !== ctx.version) {
        throw new AppError("UPDATE_CONFIRM_MISMATCH", "The running version differs", {
          running: ctx.version,
        });
      }
      const now = Date.now();
      const req = {
        id: uuidv7(now),
        action: body.action,
        tag,
        requestedBy: user.username,
        ts: now,
      };
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.request-${req.id}.tmp`);
      fs.writeFileSync(tmp, `${JSON.stringify(req)}\n`, { mode: 0o644 });
      // `wx`-like guard: a request that appeared meanwhile is not overwritten.
      if (isBusy()) {
        fs.rmSync(tmp, { force: true });
        throw new AppError("UPDATE_PENDING", "An update is already pending or running");
      }
      fs.renameSync(tmp, requestFile);
      audit(db, request, {
        action: "ops.update_requested",
        targetType: "update",
        targetId: req.id,
        details: { action: req.action, tag, running: ctx.version },
      });
      return { request: { ...req, state: "pending" as const } };
    },
    { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: userOrIpKey } },
  );

  registerContract(app, cancelAdminUpdate, (_input, request) => {
    if (fs.existsSync(runningFile))
      throw new AppError("UPDATE_PENDING", "The update is already running");
    const pending = readRequest(requestFile, "pending");
    try {
      fs.unlinkSync(requestFile);
    } catch {
      throw new AppError("NOT_FOUND", "No pending update request");
    }
    audit(db, request, {
      action: "ops.update_cancelled",
      targetType: "update",
      targetId: pending?.id ?? null,
      details: { action: pending?.action ?? null, tag: pending?.tag ?? null },
    });
    return { ok: true as const };
  });
}
