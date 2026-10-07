import { createHash } from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { z } from "zod";

/**
 * Typed client for the Samply REST API (SPEC §17). Shapes were verified against the live API on
 * 2026-09-28 (see decision log): no pagination or rate-limit headers, boxes list their
 * `children` but not their parent, files carry no size or MIME type (the signed download URL does).
 */
export const SAMPLY_API_URL = "https://samply.app/api/v0";

const Person = z.looseObject({
  uid: z.string().optional(),
  displayName: z.string().nullish(),
  email: z.string().nullish(),
});

export const SamplyProjectSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  color: z.string().nullish(),
  /** Artwork image URL (may be empty). */
  artwork: z.string().nullish(),
  /** Total bytes of the project's files. */
  size: z.number().nullish(),
  creator: Person.nullish(),
  timeCreated: z.number().nullish(),
  timeModified: z.number().nullish(),
});
export type SamplyProject = z.infer<typeof SamplyProjectSchema>;

export const SamplyBoxSchema = z.looseObject({
  id: z.string(),
  object: z.enum(["file", "folder", "stack"]),
  name: z.string(),
  color: z.string().nullish(),
  timeCreated: z.number().nullish(),
  children: z.array(z.looseObject({ id: z.string(), name: z.string().nullish() })).default([]),
  trashed: z.boolean().nullish(),
  hidden: z.boolean().nullish(),
  /** Seconds; present on audio files only. */
  duration: z.number().nullish(),
});
export type SamplyBox = z.infer<typeof SamplyBoxSchema>;

export const SamplyCommentSchema = z.looseObject({
  id: z.string(),
  message: z.string().default(""),
  audioTimestamp: z.number().nullish(),
  audioTimestampEnd: z.number().nullish(),
  completed: z.boolean().nullish(),
  parentid: z.string().nullish(),
  isReply: z.boolean().nullish(),
  creator: Person.nullish(),
  reactions: z
    .record(
      z.string(),
      z.looseObject({ count: z.number().nullish(), users: z.record(z.string(), Person).nullish() }),
    )
    .nullish(),
  timeCreated: z.number().nullish(),
  timeModified: z.number().nullish(),
});
export type SamplyComment = z.infer<typeof SamplyCommentSchema>;

export const SamplyInsightSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  boxid: z.string().nullish(),
  playerid: z.string().nullish(),
  completion: z.number().nullish(),
  country: z.string().nullish(),
  userName: z.string().nullish(),
  timeCreated: z.number().nullish(),
});
export type SamplyInsight = z.infer<typeof SamplyInsightSchema>;

export const SamplyDownloadSchema = z.looseObject({ url: z.string(), expires: z.number() });

/** Failure talking to Samply. `status` 0 = network error. */
export interface DownloadLimits {
  maxBytes?: number;
  admit?: (declaredBytes: number | null) => Promise<void>;
}

/** A Samply file is larger than this server accepts for one upload (`MAX_UPLOAD_BYTES`). */
export class FileTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`File larger than ${String(maxBytes)} bytes`);
    this.name = "FileTooLargeError";
  }
}

export class SamplyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SamplyApiError";
  }
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface SamplyClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Minimum gap between API calls (the API documents no rate limits; stay gentle). */
  minIntervalMs?: number;
  maxRetries?: number;
  /** Base backoff; doubled per attempt, capped at 30 s (Retry-After wins when sent). */
  backoffMs?: number;
  signal?: AbortSignal;
  /** Default limits of {@link SamplyClient.download}. */
  downloadLimits?: DownloadLimits;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      },
      { once: true },
    );
  });

const retryable = (status: number) => status === 429 || status >= 500 || status === 0;

export class SamplyClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private nextCallAt = 0;

  constructor(private readonly opts: SamplyClientOptions) {
    this.baseUrl = (opts.baseUrl ?? SAMPLY_API_URL).replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? fetch;
    this.minIntervalMs = opts.minIntervalMs ?? 250;
    this.maxRetries = opts.maxRetries ?? 5;
    this.backoffMs = opts.backoffMs ?? 500;
  }

  /** Runs `attempt` with retries on 429/5xx/network errors and exponential backoff. */
  private async withRetry(what: string, attempt: () => Promise<Response>): Promise<Response> {
    for (let i = 0; ; i++) {
      let res: Response | null = null;
      let status = 0;
      try {
        res = await attempt();
        status = res.status;
        if (res.ok) return res;
      } catch (err) {
        if (this.opts.signal?.aborted) throw err;
      }
      if (!retryable(status) || i >= this.maxRetries) {
        const detail = res ? await res.text().catch(() => "") : "network error";
        throw new SamplyApiError(status, `${what}: ${status || "network"} ${detail.slice(0, 200)}`);
      }
      const retryAfter = Number(res?.headers.get("retry-after"));
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30_000, this.backoffMs * 2 ** i);
      await sleep(delay, this.opts.signal);
    }
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const wait = this.nextCallAt - Date.now();
    this.nextCallAt = Math.max(Date.now(), this.nextCallAt) + this.minIntervalMs;
    if (wait > 0) await sleep(wait, this.opts.signal);
    const res = await this.withRetry(`GET ${path.replace(/\/[A-Za-z0-9_-]{12,}/g, "/:id")}`, () =>
      this.fetchFn(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, Accept: "application/json" },
        signal: this.opts.signal,
      }),
    );
    return schema.parse(await res.json());
  }

  listProjects(): Promise<SamplyProject[]> {
    return this.get("/projects", z.array(SamplyProjectSchema));
  }

  /** All boxes of a project (files, folders, stacks); hidden boxes are excluded by Samply. */
  listBoxes(projectId: string): Promise<SamplyBox[]> {
    return this.get(`/projects/${enc(projectId)}/all`, z.array(SamplyBoxSchema));
  }

  listComments(projectId: string, fileId: string): Promise<SamplyComment[]> {
    return this.get(
      `/projects/${enc(projectId)}/files/${enc(fileId)}/comments`,
      z.array(SamplyCommentSchema),
    );
  }

  /** Newest first; the API returns at most 100 and has no pagination. */
  listInsights(projectId: string, limit = 100): Promise<SamplyInsight[]> {
    return this.get(
      `/projects/${enc(projectId)}/insights?limit=${limit}`,
      z.array(SamplyInsightSchema),
    );
  }

  /** A signed, time-limited URL for the original file. */
  downloadUrl(projectId: string, fileId: string): Promise<{ url: string; expires: number }> {
    return this.get(
      `/projects/${enc(projectId)}/files/${enc(fileId)}/download`,
      SamplyDownloadSchema,
    );
  }

  /** Size and type of a signed URL without downloading it. */
  async head(url: string): Promise<{ sizeBytes: number | null; contentType: string | null }> {
    const res = await this.withRetry("HEAD download", () =>
      this.fetchFn(url, { method: "HEAD", signal: this.opts.signal }),
    );
    const len = Number(res.headers.get("content-length"));
    return {
      sizeBytes: Number.isFinite(len) && len >= 0 ? len : null,
      contentType: res.headers.get("content-type"),
    };
  }

  /**
   * Streams a signed URL to `dest`, hashing on the way (never buffers the file in memory).
   * `maxBytes` refuses larger files (by Content-Length, and while streaming); `admit` sees the
   * declared size before anything is written (e.g. a free-disk check) and may throw.
   */
  async download(
    url: string,
    dest: string,
    opts: DownloadLimits = this.opts.downloadLimits ?? {},
  ): Promise<{ sha256: string; sizeBytes: number; contentType: string | null }> {
    const res = await this.withRetry("download", () =>
      this.fetchFn(url, { signal: this.opts.signal }),
    );
    if (!res.body) throw new SamplyApiError(res.status, "download: empty body");
    const len = Number(res.headers.get("content-length") ?? Number.NaN);
    const declared = Number.isFinite(len) && len >= 0 ? len : null;
    const max = opts.maxBytes ?? Number.POSITIVE_INFINITY;
    const tooLarge = () => new FileTooLargeError(max);
    if (declared !== null && declared > max) {
      await res.body.cancel();
      throw tooLarge();
    }
    if (opts.admit) {
      try {
        await opts.admit(declared);
      } catch (err) {
        await res.body.cancel();
        throw err;
      }
    }
    const hash = createHash("sha256");
    let size = 0;
    const source = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    source.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.length;
      if (size > max) source.destroy(tooLarge());
    });
    await pipeline(source, fs.createWriteStream(dest), { signal: this.opts.signal });
    return {
      sha256: hash.digest("hex"),
      sizeBytes: size,
      contentType: res.headers.get("content-type"),
    };
  }
}

const enc = encodeURIComponent;
